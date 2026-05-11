import { CDPClient, CDPDiscoveryOptions } from "./cdp";
import { CursorRenderer, Renderer, DEFAULT_CURSOR } from "./renderer";
import { Pt } from "./bezier";

export type SpeedPreset = "fast" | "normal" | "slow";

export interface ConnectOptions extends CDPDiscoveryOptions {
  cursor?: string;
  size?: number;
  speed?: number;
  wsUrl?: string;
  pace?: SpeedPreset;
}

export interface PaceTimings {
  move: number;
  highlight: number;
  press: number;
  release: number;
  observe: number;
  pressScale: number;
}

export const PACE: Record<SpeedPreset, PaceTimings> = {
  fast:   { move: 100, highlight: 50,  press: 30,  release: 20,  observe: 50,  pressScale: 30 },
  normal: { move: 400, highlight: 400, press: 150, release: 100, observe: 300, pressScale: 80 },
  slow:   { move: 700, highlight: 800, press: 250, release: 150, observe: 600, pressScale: 120 },
};

export function resolvePace(opts: ConnectOptions): { preset: SpeedPreset; t: PaceTimings } {
  const fromEnv = process.env.PAW_SPEED as SpeedPreset | undefined;
  const preset: SpeedPreset = opts.pace || fromEnv || "normal";
  if (!PACE[preset]) return { preset: "normal", t: PACE.normal };
  return { preset, t: PACE[preset] };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  role: string;
  name: string;
  offscreen: boolean;
}

export interface NearbyEntry {
  idx: number;
  role: string;
  name: string;
  x: number;
  y: number;
  dist: number;
  offscreen: boolean;
}

export interface LogEntry {
  t: number;
  kind: "console" | "net" | "error";
  level?: string;
  msg?: string;
  method?: string;
  url?: string;
  status?: number;
  ms?: number;
  err?: string;
  file?: string;
  line?: number;
}

export type MouseButton = "left" | "middle" | "right";
export type Target = string | number;

export async function connect(opts: ConnectOptions = {}): Promise<Paw> {
  let client: CDPClient;
  if (opts.wsUrl) client = await CDPClient.attach(opts.wsUrl);
  else client = await CDPClient.discover(opts);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("DOM.enable");
  // Defeat background-tab throttling: when the terminal has focus and Brave is
  // backgrounded, CSS animations pause and `animationend` never fires — which
  // breaks every cursor walk. These two CDP overrides make the page think it
  // is focused + active without actually stealing focus from the user's shell.
  try { await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
  try { await client.send("Page.setWebLifecycleState", { state: "active" }); } catch {}
  const renderer: Renderer = new CursorRenderer(client, {
    cursor: opts.cursor ?? DEFAULT_CURSOR,
    size: opts.size ?? 32,
    speed: opts.speed ?? 1500,
  });
  await renderer.install();
  // Honor PAW_GRAB_KEY env (alt|ctrl|shift|meta|cmd) — remaps the modifier
  // for human-takeover-via-mouse. Set every install because new-document
  // injections reset window state on navigation; the page script still
  // falls back to altKey if __paw_grab_mod is unset.
  const grab = (process.env.PAW_GRAB_KEY || "").toLowerCase();
  const grabMap: Record<string, string> = {
    alt: "altKey", ctrl: "ctrlKey", shift: "shiftKey",
    meta: "metaKey", cmd: "metaKey", win: "metaKey",
  };
  if (grab && grabMap[grab]) {
    await client.send("Runtime.evaluate", {
      expression: `window.__paw_grab_mod = ${JSON.stringify(grabMap[grab])}`,
    });
  }
  const pace = resolvePace(opts);
  return new Paw(client, renderer, pace.t);
}

export class Paw {
  /** Suppresses cursor animation + highlight ceremony. Real CDP events still fire. */
  public silent = false;
  constructor(public readonly client: CDPClient, private readonly animator: Renderer, private readonly pace: PaceTimings = PACE.normal) {}

  async box(selector: string): Promise<Box> {
    const res = await this.client.send<{ result: { value: Box | null } }>("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
      returnByValue: true,
    });
    const v = res.result?.value;
    if (!v) throw new Error(`paw: element not found: ${selector}`);
    return v;
  }

  async center(target: Target): Promise<Pt> {
    const expr =
      typeof target === "number"
        ? `window.__paw && window.__paw.liveCenter(${target})`
        : `window.__paw && window.__paw.liveSel(${JSON.stringify(target)})`;
    const res = await this.client.send<{ result: { value: Pt | null } }>("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    const v = res.result?.value;
    if (!v) {
      const what = typeof target === "number" ? `snapshot [${target}]` : target;
      throw new Error(`paw: ${what} not found or stale. ${typeof target === "number" ? "Run `paw snapshot` again." : ""}`);
    }
    return v;
  }

  async snapshot(): Promise<SnapshotEntry[]> {
    const res = await this.client.send<{ result: { value: (SnapshotEntry | null)[] } }>("Runtime.evaluate", {
      expression: "window.__paw.snapshot()",
      returnByValue: true,
    });
    const arr = res.result?.value ?? [];
    return arr.slice(1).filter((e): e is SnapshotEntry => !!e);
  }

  async nearby(radius = 200, limit = 12): Promise<NearbyEntry[]> {
    const res = await this.client.send<{ result: { value: NearbyEntry[] } }>("Runtime.evaluate", {
      expression: `window.__paw.nearby(${radius}, ${limit})`,
      returnByValue: true,
    });
    return res.result?.value ?? [];
  }

  /** Snapshot filtered to only viewport-visible elements — what the human can actually see right now. */
  async visible(): Promise<(SnapshotEntry & { idx: number })[]> {
    const res = await this.client.send<{ result: { value: any[] } }>("Runtime.evaluate", {
      expression: "window.__paw.visible()",
      returnByValue: true,
    });
    return res.result?.value ?? [];
  }

  /** Scroll a text-substring or CSS selector into viewport center. Bridges the AI/human visual gap. */
  async show(target: string): Promise<{ tag: string; text: string; rect: { x: number; y: number; w: number; h: number } } | null> {
    const res = await this.client.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: `window.__paw.show(${JSON.stringify(target)})`,
      returnByValue: true,
    });
    return res.result?.value ?? null;
  }

  async entry(n: number): Promise<SnapshotEntry> {
    const res = await this.client.send<{ result: { value: SnapshotEntry | null } }>("Runtime.evaluate", {
      expression: `(window.__paw_snapshot && window.__paw_snapshot[${n}]) || null`,
      returnByValue: true,
    });
    if (!res.result?.value) throw new Error(`paw: no snapshot entry [${n}]. Run \`paw snapshot\` first.`);
    return res.result.value;
  }

  position(): Pt {
    return this.animator.position();
  }

  async moveTo(x: number, y: number): Promise<void> {
    if (this.silent) {
      await this.dispatch("mouseMoved", x, y, "none", 0);
      this.animator.setPosition({ x, y });
      return;
    }
    // Page-side press state survives across paw invocations. If a previous
    // `paw press` is still active, every subsequent move must dispatch
    // mouseMoved events in lockstep so the dragged element follows along.
    const pressed = await this.eval<{ button: string; buttons: number } | null>("window.__paw_pressed || null");
    if (pressed) {
      await this.animator.moveTo({ x, y }, { duration: this.pace.move, dispatchMouseEvents: true, buttons: pressed.buttons });
    } else {
      await this.animator.moveTo({ x, y }, { duration: this.pace.move });
      // Land a mouseMoved at the endpoint so the page knows the mouse arrived.
      await this.dispatch("mouseMoved", x, y, "none", 0);
    }
  }

  async moveBy(dx: number, dy: number): Promise<{ x: number; y: number }> {
    const p = this.animator.position();
    const nx = p.x + dx;
    const ny = p.y + dy;
    await this.moveTo(nx, ny);
    return { x: nx, y: ny };
  }

  async press(button: MouseButton = "left"): Promise<void> {
    const p = this.animator.position();
    await this.dispatch("mousePressed", p.x, p.y, button, 1);
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    await this.client.send("Runtime.evaluate", {
      expression: `window.__paw_pressed = { button: ${JSON.stringify(button)}, buttons: ${buttons} }`,
    });
  }

  async release(button: MouseButton = "left"): Promise<void> {
    const p = this.animator.position();
    await this.dispatch("mouseReleased", p.x, p.y, button, 1);
    await this.client.send("Runtime.evaluate", { expression: "window.__paw_pressed = null" });
  }

  async click(target: Target, button: MouseButton = "left"): Promise<void> {
    const c = await this.center(target);
    if (this.silent) {
      await this.dispatch("mousePressed", c.x, c.y, button, 1);
      await this.dispatch("mouseReleased", c.x, c.y, button, 1);
      return;
    }
    await this.animator.moveTo(c, { duration: this.pace.move });
    await this.animator.highlight(target);
    await sleep(this.pace.highlight);
    await this.animator.pressScale(0.85, this.pace.pressScale);
    await this.dispatch("mousePressed", c.x, c.y, button, 1);
    await sleep(this.pace.press);
    await this.dispatch("mouseReleased", c.x, c.y, button, 1);
    await this.animator.pressScale(1, this.pace.pressScale);
    await sleep(this.pace.release);
    await this.animator.unhighlight();
    await sleep(this.pace.observe);
  }

  async dblclick(target: Target): Promise<void> {
    const c = await this.center(target);
    if (this.silent) {
      await this.dispatch("mousePressed", c.x, c.y, "left", 1);
      await this.dispatch("mouseReleased", c.x, c.y, "left", 1);
      await this.dispatch("mousePressed", c.x, c.y, "left", 2);
      await this.dispatch("mouseReleased", c.x, c.y, "left", 2);
      return;
    }
    await this.animator.moveTo(c, { duration: this.pace.move });
    await this.animator.highlight(target);
    await sleep(this.pace.highlight);
    await this.animator.pressScale(0.85, this.pace.pressScale);
    await this.dispatch("mousePressed", c.x, c.y, "left", 1);
    await this.dispatch("mouseReleased", c.x, c.y, "left", 1);
    await this.dispatch("mousePressed", c.x, c.y, "left", 2);
    await this.dispatch("mouseReleased", c.x, c.y, "left", 2);
    await this.animator.pressScale(1, this.pace.pressScale);
    await sleep(this.pace.release);
    await this.animator.unhighlight();
    await sleep(this.pace.observe);
  }

  async rightclick(target: Target): Promise<void> {
    return this.click(target, "right");
  }

  async hover(target: Target): Promise<void> {
    const c = await this.center(target);
    if (this.silent) {
      await this.dispatch("mouseMoved", c.x, c.y, "none", 0);
      return;
    }
    await this.animator.moveTo(c, { duration: this.pace.move });
    await this.dispatch("mouseMoved", c.x, c.y, "none", 0);
    await this.animator.highlight(target, "#3b82f6");
    await sleep(this.pace.highlight);
    await this.animator.unhighlight();
  }

  async type(target: Target, text: string): Promise<void> {
    await this.click(target);
    await this.client.send("Input.insertText", { text });
  }

  async keypress(key: string, modifiers = 0): Promise<void> {
    await this.client.send("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers });
    await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
  }

  async drag(from: Target, to: Target): Promise<void> {
    const a = await this.center(from);
    const b = await this.center(to);
    await this.animator.moveTo(a);
    await this.dispatch("mousePressed", a.x, a.y, "left", 1);
    await this.animator.moveTo(b, { dispatchMouseEvents: true, buttons: 1 });
    await this.dispatch("mouseReleased", b.x, b.y, "left", 1);
  }

  async scroll(direction: "up" | "down" | "left" | "right", pixels = 400): Promise<void> {
    const c = this.animator.position();
    let dx = 0,
      dy = 0;
    if (direction === "down") dy = pixels;
    else if (direction === "up") dy = -pixels;
    else if (direction === "right") dx = pixels;
    else dx = -pixels;
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: c.x,
      y: c.y,
      button: "none",
      deltaX: dx,
      deltaY: dy,
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.client.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async goto(url: string, waitForLoad = true): Promise<void> {
    if (waitForLoad) {
      const loaded = new Promise<void>((resolve) => {
        const off = this.client.on("Page.loadEventFired", () => {
          off();
          resolve();
        });
      });
      await this.client.send("Page.navigate", { url });
      await loaded;
    } else {
      await this.client.send("Page.navigate", { url });
    }
  }

  async screenshot(): Promise<Buffer> {
    const res = await this.client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return Buffer.from(res.data, "base64");
  }

  async waitFor(target: Target, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let found: boolean;
      if (typeof target === "number") {
        found = await this.eval<boolean>(`!!(window.__paw_snapshot && window.__paw_snapshot[${target}])`);
      } else {
        found = await this.eval<boolean>(`!!document.querySelector(${JSON.stringify(target)})`);
      }
      if (found) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`paw: timeout waiting for ${target}`);
  }

  async text(target: Target): Promise<string | null> {
    if (typeof target === "number") {
      const e = await this.entry(target);
      return e.name;
    }
    return this.eval<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(target)}); return el ? (el.textContent || '').trim() : null; })()`,
    );
  }

  async html(target: Target = "html"): Promise<string | null> {
    const sel = typeof target === "number" ? null : target;
    if (sel === null) throw new Error("paw: html() does not support snapshot index");
    return this.eval<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.outerHTML : null; })()`,
    );
  }

  /** True while the human is Alt+dragging the cursor in the browser. */
  async humanGrabbing(): Promise<boolean> {
    return await this.eval<boolean>("!!window.__paw_human_grabbing");
  }

  /**
   * Wait until the human releases the cursor (Alt+drag ends).
   * Mutating actions call this before dispatching so AI and human don't
   * fight over the wheel.
   */
  async waitForUngrab(maxMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!(await this.humanGrabbing())) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Drain and return any HUMAN-TAKEOVER entries that accumulated in the page-side buffer. */
  async drainHumanLog(): Promise<{ ts: string; endTs: string; from: { x: number; y: number }; to: { x: number; y: number } }[]> {
    return await this.eval<any[]>(
      "(() => { const b = window.__paw_human_log || []; window.__paw_human_log = []; return b; })()",
    );
  }

  async dismissCookies(action: "accept" | "reject" | "list" = "accept"): Promise<{ matched: string | null; clicked: boolean; candidates: string[] }> {
    const res = await this.client.send<{ result: { value: { matched: string | null; clicked: boolean; candidates: string[] } } }>("Runtime.evaluate", {
      expression: `window.__paw && window.__paw.dismissCookies(${JSON.stringify(action)})`,
      returnByValue: true,
    });
    return res.result?.value ?? { matched: null, clicked: false, candidates: [] };
  }

  async getLog(): Promise<LogEntry[]> {
    const res = await this.client.send<{ result: { value: LogEntry[] } }>("Runtime.evaluate", {
      expression: "window.__paw_log || []",
      returnByValue: true,
    });
    return res.result?.value ?? [];
  }

  async clearLog(): Promise<void> {
    await this.client.send("Runtime.evaluate", {
      expression: "(window.__paw_log && (window.__paw_log.length = 0))",
    });
  }

  async inflight(): Promise<number> {
    const res = await this.client.send<{ result: { value: number } }>("Runtime.evaluate", {
      expression: "window.__paw_inflight | 0",
      returnByValue: true,
    });
    return res.result?.value ?? 0;
  }

  async waitIdle(stableMs = 500, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      const n = await this.inflight();
      if (n === 0) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return;
      } else {
        stableSince = 0;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`paw: wait-idle timeout (${timeoutMs}ms)`);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async dispatch(
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    x: number,
    y: number,
    button: MouseButton | "none",
    clickCount: number,
  ): Promise<void> {
    await this.client.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
