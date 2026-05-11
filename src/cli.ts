import { writeFileSync, readFileSync } from "node:fs";
import { CDPClient } from "./cdp";
import { connect, PetCursor, Target, LogEntry, SpeedPreset } from "./wrapper";
import { loadState, saveState, clearState, STATE_FILE } from "./state";
import { launch, findBrowser } from "./launch";
import { audit, describeTarget, LOG_FILE } from "./audit";

function readSource(arg: string): string {
  if (arg === "-") return readFileSync(0, "utf8");
  if (arg.startsWith("@")) return readFileSync(arg.slice(1), "utf8");
  return arg;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

async function runBatchVerb(pet: PetCursor, verb: string, args: string[]): Promise<void> {
  switch (verb) {
    case "click":
      await pet.click(parseTarget(args[0]));
      break;
    case "dblclick":
      await pet.dblclick(parseTarget(args[0]));
      break;
    case "rightclick":
      await pet.rightclick(parseTarget(args[0]));
      break;
    case "hover":
      await pet.hover(parseTarget(args[0]));
      break;
    case "type":
      await pet.type(parseTarget(args[0]), args.slice(1).join(" "));
      break;
    case "keypress":
      await pet.keypress(args[0]);
      break;
    case "drag":
      await pet.drag(parseTarget(args[0]), parseTarget(args[1]));
      break;
    case "scroll":
      await pet.scroll((args[0] || "down") as any, args[1] ? parseInt(args[1], 10) : 400);
      break;
    case "goto":
      await pet.goto(args[0]);
      break;
    case "wait-idle":
      await pet.waitIdle(args[0] ? parseInt(args[0], 10) : 500);
      break;
    case "wait":
      await pet.waitFor(parseTarget(args[0]));
      break;
    case "dismiss-cookies":
      await pet.dismissCookies(args[0] === "--reject" ? "reject" : "accept");
      break;
    case "snapshot":
      await pet.snapshot();
      break;
    case "sleep":
      await new Promise((r) => setTimeout(r, parseInt(args[0] || "0", 10)));
      break;
    case "eval":
      await pet.eval(args.join(" "));
      break;
    default:
      throw new Error(`pet batch: verb "${verb}" not supported in batch mode`);
  }
  await audit(`batch:${verb} ${args.join(" ")}`);
}

async function withSession<T>(fn: (pet: PetCursor) => Promise<T>, opts: { pace?: SpeedPreset; silent?: boolean; readOnly?: boolean } = {}): Promise<T> {
  const s = loadState();
  const pet = await connect({ wsUrl: s.WS_URL, pace: opts.pace });
  if (opts.silent) pet.silent = true;
  // Drain page-side human-takeover buffer FIRST so audit logs stay in temporal order
  const humanEntries = await pet.drainHumanLog();
  for (const e of humanEntries) {
    await audit(`grab (${e.from.x},${e.from.y}) → (${e.to.x},${e.to.y})`, "HUMAN-TAKEOVER", e.endTs);
  }
  // Block mutating actions until the human releases the wheel
  if (!opts.readOnly) await pet.waitForUngrab();
  try {
    return await fn(pet);
  } finally {
    await pet.close();
  }
}

function parseSilent(flags: Record<string, string | boolean>): boolean {
  if (flags.silent) return true;
  if (flags.renderer === "none") return true;
  if (flags.renderer && flags.renderer !== "cursor" && flags.renderer !== "none") {
    throw new Error(`pet: --renderer "${flags.renderer}" not yet implemented. v0.1 supports: cursor (default), none. PetRenderer planned v0.3, HighlightRenderer v0.4.`);
  }
  return false;
}

function parsePace(flags: Record<string, string | boolean>): SpeedPreset | undefined {
  const v = flags.speed;
  if (v === true) return undefined;
  if (typeof v === "string") {
    if (v === "fast" || v === "normal" || v === "slow") return v;
  }
  return undefined;
}

function parseTarget(s: string | undefined): Target {
  if (s === undefined) throw new Error("pet: missing target (snapshot index or selector)");
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : s;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function parseSince(s: string): number {
  const m = /^(\d+)(ms|s|m)?$/.exec(s.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const u = m[2] || "ms";
  return u === "ms" ? n : u === "s" ? n * 1000 : n * 60000;
}

function parseStatusFilter(s: string): (n: number) => boolean {
  const m = /^(>=|<=|>|<|=|!=)?\s*(\d+)$/.exec(s.trim());
  if (!m) return () => true;
  const op = m[1] || "=";
  const v = parseInt(m[2], 10);
  return (n) => {
    if (op === ">=") return n >= v;
    if (op === "<=") return n <= v;
    if (op === ">") return n > v;
    if (op === "<") return n < v;
    if (op === "!=") return n !== v;
    return n === v;
  };
}

function fmtAgo(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function fmtSnapshot(entries: { role: string; name: string; offscreen: boolean }[]): string {
  if (!entries.length) return "(no interactive elements found)";
  const roleW = Math.min(12, Math.max(4, ...entries.map((e) => e.role.length)));
  const lines = entries.map((e, i) => {
    const num = `[${i + 1}]`.padStart(5);
    const role = pad(e.role, roleW);
    const name = e.name || "(no name)";
    const tag = e.offscreen ? "  (offscreen)" : "";
    return `${num} ${role}  ${name}${tag}`;
  });
  return lines.join("\n");
}

const HELP = `pet — visualized CDP client. AI-driven, curl-shaped, depth-1.

  pet start [brave|chrome|edge] [--url U] [--port P]   auto-launch + connect
  pet connect <port> [url-substring]    open session (writes ${STATE_FILE})
  pet close                             clear session file
  pet snapshot                          list ALL interactive elements (numbered)
  pet nearby [--radius N] [--limit N]   only elements within radius of cursor (saves tokens)
  pet dismiss-cookies [--reject|--list] kill OneTrust/Cookiebot/Didomi/... banners
  pet log [--since Ns] [--type T] [--status '>=N']   dump page log (console+net+error)
  pet log clear                         empty buffer
  pet wait-idle [stableMs=500] [--timeout N=30000]   block until network quiet

  pet click <n|sel> [--speed fast|normal|slow] [--right|--middle]  cursor walks → highlight → real click
  pet dblclick <n|sel> [--speed S]
  pet rightclick <n|sel> [--speed S]
  pet hover <n|sel> [--speed S]
  pet type <n|sel> <text|@file|-> [--speed S]   click + Input.insertText
  pet keypress <key>                    e.g. Enter, Tab, ArrowDown
  pet drag <from> <to>                  press → move-with-button → release
  pet scroll <up|down|left|right> [px]

  cursor as a first-class object (compose any motion):
  pet move <x> <y> [--speed S]          cursor walks to absolute viewport coords
  pet moveby <dx> <dy>                  cursor walks by relative offset
  pet press [--right|--middle]          mouseDown at current cursor pos
  pet release [--right|--middle]        mouseUp at current cursor pos

  pet goto <url>                        Page.navigate (waits for load)
  pet eval <expr|@file.js|->            Runtime.evaluate; expr from file (@) or stdin (-)
  pet screenshot [path]                 default: ./screenshot.png
  pet text <n|sel>                      textContent
  pet html [sel]                        outerHTML, defaults to <html>
  pet wait <n|sel> [--timeout ms]       poll until present
  pet position                          current cursor x y
  pet box <sel>                         bounding rect

  pet batch [@file|-]                   run multiple verbs in ONE CDP session (stdin or file)
  pet stay                              pin cursor in place (no idle rest)
  pet unstay                            re-enable 5s idle rest
  pet auto                              (info) auto is the default
  pet play                              interactive WASD (v0.6, not yet)
  pet help [verb]

target = positive integer (snapshot/nearby index) or CSS selector
speed  = fast (~280ms) | normal (~1.4s, default) | slow (~3.5s, demo)
         each click does: bezier move → highlight → press-shrink → release → pause
         PET_SPEED=fast for global default, --speed S to override per call
silent = --silent or --renderer none → real CDP fires, no cursor/highlight
         --renderer cursor (default). pet|highlight reserved for v0.3+
output = plain text. no JSON envelopes anywhere.
state  = ~/.pet-cursor (KEY=VALUE, shell-sourceable)
audit  = ~/.pet-cursor.log (every action, ISO ts + line, append-only, mode 0600)
         PET_ELASTIK=http://host:port  also PUT each action to /home/log/pet/<iso>
         PET_ELASTIK_TOKEN=... (or ELASTIK_WRITE_TOKEN=...) for write auth
         PET_NO_AUDIT=1                disable both local and remote audit
         consumer side: \`curl PET_ELASTIK/listen/home/log/pet/*\` for SSE stream`;

interface Flags {
  pos: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Flags {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

async function main(): Promise<number> {
  const verb = process.argv[2];
  const rest = process.argv.slice(3);
  const { pos, flags } = parseArgs(rest);

  if (!verb || verb === "help" || verb === "-h" || verb === "--help") {
    console.log(HELP);
    return 0;
  }

  switch (verb) {
    case "start": {
      const port = flags.port ? parseInt(String(flags.port), 10) : 9222;
      const url = (flags.url as string) || "about:blank";
      const browser = pos[0] || (flags.browser as string | undefined);
      const r = await launch({ port, url, browser });
      const target = await CDPClient.discoverTarget({ port });
      saveState({
        HOST: "127.0.0.1",
        PORT: String(port),
        WS_URL: target.webSocketDebuggerUrl,
        PAGE_URL: target.url,
        TITLE: target.title,
      });
      const pet = await connect({ wsUrl: target.webSocketDebuggerUrl });
      await pet.close();
      console.log(`started ${r.brand} (${r.binary}) on port ${port}`);
      console.log(`         ↳ ${target.url}`);
      console.log(`         ↳ ${STATE_FILE}`);
      await audit(`start ${r.brand} port=${port} url=${target.url}`);
      return 0;
    }

    case "dismiss-cookies": {
      const action: "accept" | "reject" | "list" = flags.list ? "list" : flags.reject ? "reject" : "accept";
      const r = await withSession((pet) => pet.dismissCookies(action));
      if (action === "list") {
        if (r.candidates.length === 0) console.log("no CMP detected");
        else r.candidates.forEach((c) => console.log(c));
      } else if (r.matched) {
        console.log(`${r.matched}: ${r.clicked ? action + "ed" : "not clicked"}`);
        await audit(`dismiss-cookies ${r.matched} ${action}ed`);
      } else {
        console.log("no CMP detected");
        return 2 as any;
      }
      return 0;
    }

    case "log": {
      if (pos[0] === "clear") {
        await withSession((pet) => pet.clearLog(), { readOnly: true });
        console.log("log cleared");
        return 0;
      }
      const since = flags.since ? parseSince(String(flags.since)) : 0;
      const type = flags.type ? String(flags.type) : "";
      const statusFilter = flags.status ? parseStatusFilter(String(flags.status)) : null;
      const entries = await withSession((pet) => pet.getLog(), { readOnly: true });
      const now = Date.now();
      const filtered = entries.filter((e) => {
        if (since && now - e.t > since) return false;
        if (type && e.kind !== type) return false;
        if (statusFilter && e.kind === "net" && !statusFilter(e.status ?? 0)) return false;
        return true;
      });
      if (!filtered.length) {
        console.log("(empty)");
        return 0;
      }
      for (const e of filtered) {
        const ago = fmtAgo(now - e.t);
        if (e.kind === "console") console.log(`${ago.padStart(7)}  console.${e.level}  ${e.msg}`);
        else if (e.kind === "net") console.log(`${ago.padStart(7)}  ${(e.method || "GET").padEnd(4)} ${String(e.status).padEnd(3)} ${String(e.ms ?? "").padStart(4)}ms  ${e.url}`);
        else if (e.kind === "error") console.log(`${ago.padStart(7)}  error  ${e.msg}${e.file ? `  (${e.file}:${e.line})` : ""}`);
      }
      return 0;
    }

    case "wait-idle": {
      const stable = pos[0] ? parseInt(pos[0], 10) : 500;
      const timeout = flags.timeout ? parseInt(String(flags.timeout), 10) : 30000;
      await withSession((pet) => pet.waitIdle(stable, timeout), { readOnly: true });
      console.log(`idle (stable ${stable}ms)`);
      return 0;
    }

    case "connect": {
      const port = pos[0] || "9222";
      const urlFilter = pos[1];
      const target = await CDPClient.discoverTarget({
        host: "127.0.0.1",
        port: parseInt(port, 10),
        pageUrl: urlFilter,
      });
      saveState({
        HOST: "127.0.0.1",
        PORT: port,
        WS_URL: target.webSocketDebuggerUrl,
        PAGE_URL: target.url,
        TITLE: target.title,
      });
      const pet = await connect({ wsUrl: target.webSocketDebuggerUrl });
      await pet.close();
      console.log(`connected → ${target.title || "(untitled)"}`);
      console.log(`         ↳ ${target.url}`);
      console.log(`         ↳ ${STATE_FILE}`);
      await audit(`connect port=${port} url=${target.url}`);
      return 0;
    }

    case "close": {
      clearState();
      console.log(`session cleared (${STATE_FILE})`);
      await audit("close");
      return 0;
    }

    case "snapshot": {
      await withSession(async (pet) => {
        const entries = await pet.snapshot();
        console.log(fmtSnapshot(entries));
        const url = await pet.eval<string>("location.href");
        await audit(`snapshot ${entries.length} elements at ${url}`);
      }, { readOnly: true });
      return 0;
    }

    case "nearby": {
      const radius = flags.radius ? parseInt(String(flags.radius), 10) : 200;
      const limit = flags.limit ? parseInt(String(flags.limit), 10) : 12;
      await withSession(async (pet) => {
        const entries = await pet.nearby(radius, limit);
        if (!entries.length) {
          console.log(`(no interactive elements within ${radius}px of cursor)`);
        } else {
          const roleW = Math.min(12, Math.max(4, ...entries.map((e) => e.role.length)));
          for (const e of entries) {
            const num = `[${e.idx}]`.padStart(5);
            const role = pad(e.role, roleW);
            const name = e.name || "(no name)";
            const dist = `${Math.round(e.dist)}px`.padStart(6);
            const tag = e.offscreen ? "  (offscreen)" : "";
            console.log(`${num} ${role}  ${name}${tag}  ${dist}`);
          }
        }
        await audit(`nearby ${entries.length} within ${radius}px`);
      }, { readOnly: true });
      return 0;
    }

    case "click": {
      const t = parseTarget(pos[0]);
      const button = flags.right ? "right" : flags.middle ? "middle" : "left";
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const desc = await describeTarget((n) => pet.entry(n), t);
        await pet.click(t, button as any);
        const p = pet.position();
        await audit(`click ${desc} at (${Math.round(p.x)},${Math.round(p.y)})${button === "left" ? "" : " " + button}`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "dblclick": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const desc = await describeTarget((n) => pet.entry(n), t);
        await pet.dblclick(t);
        const p = pet.position();
        await audit(`dblclick ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "rightclick": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const desc = await describeTarget((n) => pet.entry(n), t);
        await pet.rightclick(t);
        const p = pet.position();
        await audit(`rightclick ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "hover": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const desc = await describeTarget((n) => pet.entry(n), t);
        await pet.hover(t);
        const p = pet.position();
        await audit(`hover ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "type": {
      const t = parseTarget(pos[0]);
      if (pos.length < 2) throw new Error("pet type: missing text (use `@file.txt` or `-` for stdin)");
      const text = (pos[1] === "-" || pos[1].startsWith("@")) ? readSource(pos[1]) : pos.slice(1).join(" ");
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const desc = await describeTarget((n) => pet.entry(n), t);
        await pet.type(t, text);
        const preview = text.length > 40 ? text.slice(0, 37) + "..." : text;
        await audit(`type ${desc} "${preview.replace(/"/g, '\\"')}" (${text.length} chars)`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "keypress": {
      const key = pos[0];
      if (!key) throw new Error("pet keypress: missing key");
      await withSession((pet) => pet.keypress(key));
      await audit(`keypress ${key}`);
      return 0;
    }

    case "drag": {
      const a = parseTarget(pos[0]);
      const b = parseTarget(pos[1]);
      await withSession(async (pet) => {
        const da = await describeTarget((n) => pet.entry(n), a);
        const db = await describeTarget((n) => pet.entry(n), b);
        await pet.drag(a, b);
        await audit(`drag ${da} → ${db}`);
      });
      return 0;
    }

    case "scroll": {
      const dir = (pos[0] || "down") as "up" | "down" | "left" | "right";
      const px = pos[1] ? parseInt(pos[1], 10) : 400;
      await withSession((pet) => pet.scroll(dir, px));
      await audit(`scroll ${dir} ${px}px`);
      return 0;
    }

    case "goto": {
      const url = pos[0];
      if (!url) throw new Error("pet goto: missing url");
      await withSession((pet) => pet.goto(url));
      await audit(`goto ${url}`);
      return 0;
    }

    case "eval": {
      if (!pos.length) throw new Error("pet eval: missing expression (use `@file.js` or `-` for stdin)");
      const expr = (pos[0] === "-" || pos[0].startsWith("@")) ? readSource(pos[0]) : pos.join(" ");
      // eval is the god-mode escape hatch. Even during human takeover the
      // human needs to be able to inspect/reset state via eval — otherwise
      // a stuck __pet_human_grabbing flag self-deadlocks.
      const v = await withSession((pet) => pet.eval(expr), { readOnly: true });
      if (v === undefined || v === null) console.log(String(v));
      else if (typeof v === "object") console.log(require("util").inspect(v, { depth: 4, colors: false, breakLength: 100 }));
      else console.log(String(v));
      const preview = expr.replace(/\s+/g, " ").trim();
      await audit(`eval ${preview.length > 120 ? preview.slice(0, 117) + "..." : preview} (${expr.length} chars)`);
      return 0;
    }

    case "screenshot": {
      const path = pos[0] || "screenshot.png";
      const buf = await withSession((pet) => pet.screenshot(), { readOnly: true });
      writeFileSync(path, buf);
      console.log(path);
      await audit(`screenshot ${path} (${buf.length} bytes)`);
      return 0;
    }

    case "text": {
      const v = await withSession((pet) => pet.text(parseTarget(pos[0])), { readOnly: true });
      if (v !== null) process.stdout.write(v + "\n");
      else process.exit(2);
      return 0;
    }

    case "html": {
      const t = pos[0] ? parseTarget(pos[0]) : "html";
      const v = await withSession((pet) => pet.html(t as any), { readOnly: true });
      if (v !== null) process.stdout.write(v + "\n");
      else process.exit(2);
      return 0;
    }

    case "wait": {
      const t = parseTarget(pos[0]);
      const timeout = flags.timeout ? parseInt(String(flags.timeout), 10) : 5000;
      await withSession((pet) => pet.waitFor(t, timeout), { readOnly: true });
      return 0;
    }

    case "position": {
      await withSession(async (pet) => {
        const p = pet.position();
        console.log(`x=${Math.round(p.x)} y=${Math.round(p.y)}`);
      }, { readOnly: true });
      return 0;
    }

    case "move": {
      const x = parseInt(pos[0], 10);
      const y = parseInt(pos[1], 10);
      if (Number.isNaN(x) || Number.isNaN(y)) throw new Error("pet move: requires <x> <y> integers");
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        await pet.moveTo(x, y);
        await audit(`move (${x},${y})`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "moveby": {
      const dx = parseInt(pos[0], 10);
      const dy = parseInt(pos[1], 10);
      if (Number.isNaN(dx) || Number.isNaN(dy)) throw new Error("pet moveby: requires <dx> <dy> integers");
      const pace = parsePace(flags);
      await withSession(async (pet) => {
        const result = await pet.moveBy(dx, dy);
        console.log(`x=${Math.round(result.x)} y=${Math.round(result.y)}`);
        await audit(`moveby (${dx},${dy}) → (${Math.round(result.x)},${Math.round(result.y)})`);
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "press": {
      const button = flags.right ? "right" : flags.middle ? "middle" : "left";
      await withSession(async (pet) => {
        await pet.press(button as any);
        const p = pet.position();
        await audit(`press ${button} at (${Math.round(p.x)},${Math.round(p.y)})`);
      });
      return 0;
    }

    case "release": {
      const button = flags.right ? "right" : flags.middle ? "middle" : "left";
      await withSession(async (pet) => {
        await pet.release(button as any);
        const p = pet.position();
        await audit(`release ${button} at (${Math.round(p.x)},${Math.round(p.y)})`);
      });
      return 0;
    }

    case "box": {
      const sel = pos[0];
      if (!sel) throw new Error("pet box: missing selector");
      await withSession(async (pet) => {
        const b = await pet.box(sel);
        console.log(`x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.w)} h=${Math.round(b.h)}`);
      }, { readOnly: true });
      return 0;
    }

    case "batch": {
      const src = pos[0] ? readSource(pos[0]) : readSource("-");
      const lines = src.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const pace = parsePace(flags);
      const silent = parseSilent(flags);
      let executed = 0;
      await withSession(async (pet) => {
        for (const line of lines) {
          const tokens = tokenize(line);
          if (!tokens.length) continue;
          await runBatchVerb(pet, tokens[0], tokens.slice(1));
          executed++;
        }
      }, { pace, silent });
      console.log(`batch: ${executed} verbs executed`);
      await audit(`batch ${executed} verbs`);
      return 0;
    }

    case "auto": {
      console.log("pet: auto mode is already the default. every verb runs autonomously without prompting.");
      console.log("     use `pet play` for interactive WASD control (v0.6 — not yet implemented).");
      return 0;
    }

    case "stay": {
      await withSession(async (pet) => {
        await pet.eval("window.__pet && window.__pet.stay()");
      });
      console.log("stay: cursor will not rest. run `pet unstay` to re-enable.");
      await audit("stay");
      return 0;
    }

    case "unstay": {
      await withSession(async (pet) => {
        await pet.eval("window.__pet && window.__pet.unstay()");
      });
      console.log("unstay: cursor will rest after 5s idle.");
      await audit("unstay");
      return 0;
    }

    case "play": {
      console.error("pet play: interactive WASD game mode is on the v0.6 roadmap, not yet implemented.");
      console.error("          for now, drive pet from any shell with pet click/type/etc.");
      return 78;
    }

    default:
      console.error(`pet: unknown verb "${verb}". try \`pet help\`.`);
      return 64;
  }
}

main()
  .then((code) => {
    // Let the event loop drain naturally (audit fetches may still be in flight).
    // process.exit() is too harsh and can race with libuv handle teardown.
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`pet: ${e.message ?? e}`);
    process.exitCode = 1;
  });
