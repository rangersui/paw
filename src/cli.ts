import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { CDPClient } from "./cdp";
import { connect, Paw, Target, LogEntry, SpeedPreset } from "./wrapper";
import { loadState, saveState, clearState, STATE_FILE, State } from "./state";
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

async function runBatchVerb(paw: Paw, verb: string, args: string[]): Promise<void> {
  switch (verb) {
    case "click":
      await paw.click(parseTarget(args[0]));
      break;
    case "dblclick":
      await paw.dblclick(parseTarget(args[0]));
      break;
    case "rightclick":
      await paw.rightclick(parseTarget(args[0]));
      break;
    case "hover":
      await paw.hover(parseTarget(args[0]));
      break;
    case "type":
      await paw.type(parseTarget(args[0]), args.slice(1).join(" "));
      break;
    case "keypress":
      await paw.keypress(args[0]);
      break;
    case "drag":
      await paw.drag(parseTarget(args[0]), parseTarget(args[1]));
      break;
    case "scroll":
      await paw.scroll((args[0] || "down") as any, args[1] ? parseInt(args[1], 10) : 400);
      break;
    case "goto":
      await paw.goto(args[0]);
      break;
    case "wait-idle":
      await paw.waitIdle(args[0] ? parseInt(args[0], 10) : 500);
      break;
    case "wait":
      await paw.waitFor(parseTarget(args[0]));
      break;
    case "dismiss-cookies":
      await paw.dismissCookies(args[0] === "--reject" ? "reject" : "accept");
      break;
    case "snapshot":
      await paw.snapshot();
      break;
    case "sleep":
      await new Promise((r) => setTimeout(r, parseInt(args[0] || "0", 10)));
      break;
    case "eval":
      await paw.eval(args.join(" "));
      break;
    default:
      throw new Error(`paw batch: verb "${verb}" not supported in batch mode`);
  }
  await audit(`batch:${verb} ${args.join(" ")}`);
}

async function withSession<T>(fn: (paw: Paw) => Promise<T>, opts: { pace?: SpeedPreset; silent?: boolean; readOnly?: boolean } = {}): Promise<T> {
  const s = loadState();
  const paw = await connect({ wsUrl: s.WS_URL, pace: opts.pace });
  if (opts.silent) paw.silent = true;
  // Drain page-side human-takeover buffer FIRST so audit logs stay in temporal order
  const humanEntries = await paw.drainHumanLog();
  for (const e of humanEntries) {
    await audit(`grab (${e.from.x},${e.from.y}) → (${e.to.x},${e.to.y})`, "HUMAN-TAKEOVER", e.endTs);
  }
  // Block mutating actions until the human releases the wheel
  if (!opts.readOnly) await paw.waitForUngrab();
  try {
    return await fn(paw);
  } finally {
    await paw.close();
  }
}

function parseSilent(flags: Record<string, string | boolean>): boolean {
  if (flags.silent) return true;
  if (flags.renderer === "none") return true;
  if (flags.renderer && flags.renderer !== "cursor" && flags.renderer !== "none") {
    throw new Error(`paw: --renderer "${flags.renderer}" not yet implemented. v1.0 supports: cursor (default), none. PetRenderer planned v1.2, HighlightRenderer v1.3, PlatformRenderer v1.4.`);
  }
  return false;
}

function parseWhy(flags: Record<string, string | boolean>): string {
  // --why "..." flags the AI's intent for both audit log + cursor toast.
  // Falls back to PAW_WHY env so an agent loop can set context once and
  // not have to thread the string through every shell command.
  const w = flags.why;
  if (typeof w === "string" && w.length) return w;
  if (process.env.PAW_WHY) return process.env.PAW_WHY;
  return "";
}

function withWhy(line: string, why: string): string {
  return why ? `${line} — ${why}` : line;
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
  if (s === undefined) throw new Error("paw: missing target (snapshot index or selector)");
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

function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  return all.slice(-Math.max(0, n));
}

function parseAuditLine(line: string): { ts: string; origin: string; action: string } | null {
  // Format: 2026-05-11T09:15:32.198Z [AI] click [1] button "Click me" at (89,125)
  const m = /^(\S+)\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
  if (!m) return null;
  return { ts: m[1], origin: m[2], action: m[3] };
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

const HELP = `paw — visualized CDP client. AI-driven, curl-shaped, depth-1.

  paw start [brave|chrome|edge] [--url U] [--port P]   auto-launch + connect
  paw connect <port> [url-substring]    open session (writes ${STATE_FILE})
  paw close                             clear session file
  paw status                            one-line: host/port/url/title/cursor/last-action
  paw tail [-n N]                       last N audit entries from ~/.pawprint (default 10, newest first)
  paw snapshot                          list ALL interactive elements (numbered)
  paw visible                           only elements in current viewport (what the human sees)
  paw show <text|sel>                   scrollIntoView a text substring or CSS selector
  paw nearby [--radius N] [--limit N]   only elements within radius of cursor (saves tokens)
  paw dismiss-cookies [--reject|--list] kill OneTrust/Cookiebot/Didomi/... banners
  paw log [--since Ns] [--type T] [--status '>=N']   dump page log (console+net+error)
  paw log clear                         empty buffer
  paw wait-idle [stableMs=500] [--timeout N=30000]   block until network quiet

  paw click <n|sel> [--speed fast|normal|slow] [--right|--middle]  cursor walks → highlight → real click
  paw dblclick <n|sel> [--speed S]
  paw rightclick <n|sel> [--speed S]
  paw hover <n|sel> [--speed S]
  paw type <n|sel> <text|@file|-> [--speed S]   click + Input.insertText
  paw keypress <key>                    e.g. Enter, Tab, ArrowDown
  paw drag <from> <to>                  press → move-with-button → release
  paw scroll <up|down|left|right> [px]

  cursor as a first-class object (compose any motion):
  paw move <x> <y> [--speed S]          cursor walks to absolute viewport coords
  paw moveby <dx> <dy>                  cursor walks by relative offset
  paw press [--right|--middle]          mouseDown at current cursor pos
  paw release [--right|--middle]        mouseUp at current cursor pos

  paw goto <url>                        Page.navigate (waits for load)
  paw eval <expr|@file.js|->            Runtime.evaluate; expr from file (@) or stdin (-)
  paw screenshot [path]                 default: ./screenshot.png
  paw text <n|sel>                      textContent
  paw html [sel]                        outerHTML, defaults to <html>
  paw wait <n|sel> [--timeout ms]       poll until present
  paw position                          current cursor x y
  paw box <sel>                         bounding rect

  paw batch [@file|-]                   run multiple verbs in ONE CDP session (stdin or file)
  paw say <text|@file|->                pop a 1.5s speech-bubble next to the cursor (no action)
  paw stay                              pin cursor in place (no idle rest)
  paw unstay                            re-enable 5s idle rest
  paw auto                              (info) auto is the default
  paw play [--step N]                   interactive WASD; Space=click nearest, Q=quit (step=30px default)
  paw help [verb]

target = positive integer (snapshot/nearby index) or CSS selector
speed  = fast (~280ms) | normal (~1.4s, default) | slow (~3.5s, demo)
         each click does: bezier move → highlight → press-shrink → release → pause
         PAW_SPEED=fast for global default, --speed S to override per call
silent = --silent or --renderer none → real CDP fires, no cursor/highlight
         --renderer cursor (default). pet|highlight|platform reserved for v1.2+
why    = --why "..." on any action verb → 1.5s speech-bubble next to cursor +
         audit log appended with the intent. PAW_WHY=... env for once-per-shell.
         the LLM's reasoning string belongs here, not in a comment.
output = plain text. no JSON envelopes anywhere.
state  = ~/.paw (KEY=VALUE, shell-sourceable)
audit  = ~/.pawprint (every action, ISO ts + line, append-only, mode 0600)
         PAW_ELASTIK=http://host:port  also PUT each action to /home/pawprint/<iso>
         PAW_ELASTIK_TOKEN=... (or ELASTIK_WRITE_TOKEN=...) for write auth
         PAW_NO_AUDIT=1                disable both local and remote audit
         consumer side: \`curl PAW_ELASTIK/listen/home/pawprint/*\` for SSE stream
grab   = Alt+drag the cursor to take over from AI mid-task.
         PAW_GRAB_KEY=alt|ctrl|shift|meta|cmd (default alt; remap if a site or
         browser already binds Alt — Brave / Figma / Calendar / VS Code Web).`;

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
    } else if (a.length === 2 && /^-[a-zA-Z]$/.test(a)) {
      // Short flag like -n. Single `-` (stdin marker) and `-123` (negative
      // numbers for moveby) deliberately fall through to positional.
      const key = a.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !/^-[a-zA-Z]$/.test(argv[i + 1])) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
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
      const paw = await connect({ wsUrl: target.webSocketDebuggerUrl });
      await paw.close();
      console.log(`started ${r.brand} (${r.binary}) on port ${port}`);
      console.log(`         ↳ ${target.url}`);
      console.log(`         ↳ ${STATE_FILE}`);
      await audit(`start ${r.brand} port=${port} url=${target.url}`);
      return 0;
    }

    case "dismiss-cookies": {
      const action: "accept" | "reject" | "list" = flags.list ? "list" : flags.reject ? "reject" : "accept";
      const why = parseWhy(flags);
      const r = await withSession(async (paw) => {
        if (why && action !== "list") await paw.toast(why);
        return paw.dismissCookies(action);
      });
      if (action === "list") {
        if (r.candidates.length === 0) console.log("no CMP detected");
        else r.candidates.forEach((c) => console.log(c));
      } else if (r.matched) {
        console.log(`${r.matched}: ${r.clicked ? action + "ed" : "not clicked"}`);
        await audit(withWhy(`dismiss-cookies ${r.matched} ${action}ed`, why));
      } else {
        console.log("no CMP detected");
        return 2 as any;
      }
      return 0;
    }

    case "log": {
      if (pos[0] === "clear") {
        await withSession((paw) => paw.clearLog(), { readOnly: true });
        console.log("log cleared");
        return 0;
      }
      const since = flags.since ? parseSince(String(flags.since)) : 0;
      const type = flags.type ? String(flags.type) : "";
      const statusFilter = flags.status ? parseStatusFilter(String(flags.status)) : null;
      const entries = await withSession((paw) => paw.getLog(), { readOnly: true });
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
      await withSession((paw) => paw.waitIdle(stable, timeout), { readOnly: true });
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
      const paw = await connect({ wsUrl: target.webSocketDebuggerUrl });
      await paw.close();
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

    case "tail": {
      // Reverse-read ~/.pawprint, newest first. trust-through-visibility
      // depends on the human actually reading the log; this is the verb
      // that makes that happen without forcing them out to the shell.
      const n = flags.n ? parseInt(String(flags.n), 10) : (pos[0] ? parseInt(pos[0], 10) : 10);
      if (Number.isNaN(n) || n <= 0) throw new Error("paw tail: -n must be a positive integer");
      const lines = tailLines(LOG_FILE, n);
      if (!lines.length) {
        console.log("(empty — no pawprints yet)");
        return 0;
      }
      // Newest first
      for (const line of lines.slice().reverse()) {
        console.log(line);
      }
      return 0;
    }

    case "status": {
      // Read-only inspection — answers "where am I, what did I just do?"
      // Does NOT audit (querying state shouldn't pollute the log Ranger
      // reviews). Degrades gracefully if no session or CDP unreachable.
      let s: State | null = null;
      try { s = loadState(); } catch {}

      let cursorPart = "";
      let titlePart = "";
      let urlPart = "url=(none)";
      let stale = false;
      if (s) {
        urlPart = `url=${s.PAGE_URL || "(unknown)"}`;
        titlePart = s.TITLE ? ` title=${JSON.stringify(s.TITLE)}` : "";
        try {
          const paw = await connect({ wsUrl: s.WS_URL });
          const p = paw.position();
          cursorPart = ` cursor=(${Math.round(p.x)},${Math.round(p.y)})`;
          await paw.close();
        } catch {
          stale = true;
        }
      }

      let lastPart = "";
      const tail = tailLines(LOG_FILE, 1);
      if (tail.length) {
        const parsed = parseAuditLine(tail[0]);
        if (parsed) {
          const ago = Date.now() - new Date(parsed.ts).getTime();
          const action = parsed.action.length > 50 ? parsed.action.slice(0, 47) + "..." : parsed.action;
          lastPart = ` last=[${parsed.origin}] ${action} (${fmtAgo(ago)} ago)`;
        }
      }

      if (!s) {
        const hint = " (run `paw start` or `paw connect <port>` to begin)";
        console.log(`(no session)${hint}${lastPart}`);
        return 0;
      }
      const hostPort = `host=${s.HOST} port=${s.PORT}`;
      const staleTag = stale ? " (stale: CDP unreachable)" : "";
      console.log(`${hostPort} ${urlPart}${titlePart}${cursorPart}${staleTag}${lastPart}`);
      return 0;
    }

    case "snapshot": {
      await withSession(async (paw) => {
        const entries = await paw.snapshot();
        console.log(fmtSnapshot(entries));
        const url = await paw.eval<string>("location.href");
        await audit(`snapshot ${entries.length} elements at ${url}`);
      }, { readOnly: true });
      return 0;
    }

    case "visible": {
      await withSession(async (paw) => {
        const entries = await paw.visible();
        if (!entries.length) {
          console.log("(no interactive elements in current viewport)");
        } else {
          const roleW = Math.min(12, Math.max(4, ...entries.map((e: any) => e.role.length)));
          for (const e of entries) {
            const num = `[${(e as any).idx}]`.padStart(5);
            const role = pad((e as any).role, roleW);
            const name = (e as any).name || "(no name)";
            console.log(`${num} ${role}  ${name}`);
          }
        }
        await audit(`visible ${entries.length} in viewport`);
      }, { readOnly: true });
      return 0;
    }

    case "show": {
      const target = pos.join(" ");
      if (!target) throw new Error("paw show: missing target (text substring or CSS selector)");
      await withSession(async (paw) => {
        const r = await paw.show(target);
        if (!r) {
          console.log(`not found: ${target}`);
          process.exit(2 as any);
        }
        console.log(`scrolled into view: <${r.tag}> "${r.text.slice(0, 80)}${r.text.length > 80 ? "..." : ""}"`);
        console.log(`  at x=${r.rect.x} y=${r.rect.y} w=${r.rect.w} h=${r.rect.h}`);
        await audit(`show "${target.slice(0, 60)}" → <${r.tag}> at (${r.rect.x},${r.rect.y})`);
      });
      return 0;
    }

    case "nearby": {
      const radius = flags.radius ? parseInt(String(flags.radius), 10) : 200;
      const limit = flags.limit ? parseInt(String(flags.limit), 10) : 12;
      await withSession(async (paw) => {
        const entries = await paw.nearby(radius, limit);
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
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const desc = await describeTarget((n) => paw.entry(n), t);
        if (why) await paw.toast(why);
        await paw.click(t, button as any);
        const p = paw.position();
        await audit(withWhy(`click ${desc} at (${Math.round(p.x)},${Math.round(p.y)})${button === "left" ? "" : " " + button}`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "dblclick": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const desc = await describeTarget((n) => paw.entry(n), t);
        if (why) await paw.toast(why);
        await paw.dblclick(t);
        const p = paw.position();
        await audit(withWhy(`dblclick ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "rightclick": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const desc = await describeTarget((n) => paw.entry(n), t);
        if (why) await paw.toast(why);
        await paw.rightclick(t);
        const p = paw.position();
        await audit(withWhy(`rightclick ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "hover": {
      const t = parseTarget(pos[0]);
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const desc = await describeTarget((n) => paw.entry(n), t);
        if (why) await paw.toast(why);
        await paw.hover(t);
        const p = paw.position();
        await audit(withWhy(`hover ${desc} at (${Math.round(p.x)},${Math.round(p.y)})`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "type": {
      const t = parseTarget(pos[0]);
      if (pos.length < 2) throw new Error("paw type: missing text (use `@file.txt` or `-` for stdin)");
      const text = (pos[1] === "-" || pos[1].startsWith("@")) ? readSource(pos[1]) : pos.slice(1).join(" ");
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const desc = await describeTarget((n) => paw.entry(n), t);
        if (why) await paw.toast(why);
        await paw.type(t, text);
        const preview = text.length > 40 ? text.slice(0, 37) + "..." : text;
        await audit(withWhy(`type ${desc} "${preview.replace(/"/g, '\\"')}" (${text.length} chars)`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "keypress": {
      const key = pos[0];
      if (!key) throw new Error("paw keypress: missing key");
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.keypress(key);
      });
      await audit(withWhy(`keypress ${key}`, why));
      return 0;
    }

    case "drag": {
      const a = parseTarget(pos[0]);
      const b = parseTarget(pos[1]);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        const da = await describeTarget((n) => paw.entry(n), a);
        const db = await describeTarget((n) => paw.entry(n), b);
        if (why) await paw.toast(why);
        await paw.drag(a, b);
        await audit(withWhy(`drag ${da} → ${db}`, why));
      });
      return 0;
    }

    case "scroll": {
      const dir = (pos[0] || "down") as "up" | "down" | "left" | "right";
      const px = pos[1] ? parseInt(pos[1], 10) : 400;
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.scroll(dir, px);
      });
      await audit(withWhy(`scroll ${dir} ${px}px`, why));
      return 0;
    }

    case "goto": {
      const url = pos[0];
      if (!url) throw new Error("paw goto: missing url");
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.goto(url);
      });
      await audit(withWhy(`goto ${url}`, why));
      return 0;
    }

    case "eval": {
      if (!pos.length) throw new Error("paw eval: missing expression (use `@file.js` or `-` for stdin)");
      const expr = (pos[0] === "-" || pos[0].startsWith("@")) ? readSource(pos[0]) : pos.join(" ");
      const why = parseWhy(flags);
      // eval is the god-mode escape hatch. Even during human takeover the
      // human needs to be able to inspect/reset state via eval — otherwise
      // a stuck __paw_human_grabbing flag self-deadlocks.
      const v = await withSession(async (paw) => {
        if (why) await paw.toast(why);
        return paw.eval(expr);
      }, { readOnly: true });
      if (v === undefined || v === null) console.log(String(v));
      else if (typeof v === "object") console.log(require("util").inspect(v, { depth: 4, colors: false, breakLength: 100 }));
      else console.log(String(v));
      const preview = expr.replace(/\s+/g, " ").trim();
      await audit(withWhy(`eval ${preview.length > 120 ? preview.slice(0, 117) + "..." : preview} (${expr.length} chars)`, why));
      return 0;
    }

    case "screenshot": {
      const path = pos[0] || "screenshot.png";
      const buf = await withSession((paw) => paw.screenshot(), { readOnly: true });
      writeFileSync(path, buf);
      console.log(path);
      await audit(`screenshot ${path} (${buf.length} bytes)`);
      return 0;
    }

    case "text": {
      const v = await withSession((paw) => paw.text(parseTarget(pos[0])), { readOnly: true });
      if (v !== null) process.stdout.write(v + "\n");
      else process.exit(2);
      return 0;
    }

    case "html": {
      const t = pos[0] ? parseTarget(pos[0]) : "html";
      const v = await withSession((paw) => paw.html(t as any), { readOnly: true });
      if (v !== null) process.stdout.write(v + "\n");
      else process.exit(2);
      return 0;
    }

    case "wait": {
      const t = parseTarget(pos[0]);
      const timeout = flags.timeout ? parseInt(String(flags.timeout), 10) : 5000;
      await withSession((paw) => paw.waitFor(t, timeout), { readOnly: true });
      return 0;
    }

    case "position": {
      await withSession(async (paw) => {
        const p = paw.position();
        console.log(`x=${Math.round(p.x)} y=${Math.round(p.y)}`);
      }, { readOnly: true });
      return 0;
    }

    case "move": {
      const x = parseInt(pos[0], 10);
      const y = parseInt(pos[1], 10);
      if (Number.isNaN(x) || Number.isNaN(y)) throw new Error("paw move: requires <x> <y> integers");
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.moveTo(x, y);
        await audit(withWhy(`move (${x},${y})`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "moveby": {
      const dx = parseInt(pos[0], 10);
      const dy = parseInt(pos[1], 10);
      if (Number.isNaN(dx) || Number.isNaN(dy)) throw new Error("paw moveby: requires <dx> <dy> integers");
      const pace = parsePace(flags);
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        const result = await paw.moveBy(dx, dy);
        console.log(`x=${Math.round(result.x)} y=${Math.round(result.y)}`);
        await audit(withWhy(`moveby (${dx},${dy}) → (${Math.round(result.x)},${Math.round(result.y)})`, why));
      }, { pace, silent: parseSilent(flags) });
      return 0;
    }

    case "press": {
      const button = flags.right ? "right" : flags.middle ? "middle" : "left";
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.press(button as any);
        const p = paw.position();
        await audit(withWhy(`press ${button} at (${Math.round(p.x)},${Math.round(p.y)})`, why));
      });
      return 0;
    }

    case "release": {
      const button = flags.right ? "right" : flags.middle ? "middle" : "left";
      const why = parseWhy(flags);
      await withSession(async (paw) => {
        if (why) await paw.toast(why);
        await paw.release(button as any);
        const p = paw.position();
        await audit(withWhy(`release ${button} at (${Math.round(p.x)},${Math.round(p.y)})`, why));
      });
      return 0;
    }

    case "box": {
      const sel = pos[0];
      if (!sel) throw new Error("paw box: missing selector");
      await withSession(async (paw) => {
        const b = await paw.box(sel);
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
      await withSession(async (paw) => {
        for (const line of lines) {
          const tokens = tokenize(line);
          if (!tokens.length) continue;
          await runBatchVerb(paw, tokens[0], tokens.slice(1));
          executed++;
        }
      }, { pace, silent });
      console.log(`batch: ${executed} verbs executed`);
      await audit(`batch ${executed} verbs`);
      return 0;
    }

    case "auto": {
      console.log("paw: auto mode is already the default. every verb runs autonomously without prompting.");
      console.log("     use `paw play` for interactive WASD control.");
      return 0;
    }

    case "say": {
      const text = pos.length === 1 && (pos[0] === "-" || pos[0].startsWith("@")) ? readSource(pos[0]) : pos.join(" ");
      if (!text.trim()) throw new Error("paw say: missing text (or pass `@file` / `-` for stdin)");
      // Read pause = 1500ms so the bubble is mostly visible when paw exits.
      // Page-side fade-out continues independently if the user moves on.
      await withSession(async (paw) => {
        await paw.toast(text, 1500);
      }, { readOnly: true });
      const preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
      await audit(`say "${preview.replace(/"/g, '\\"')}"`);
      return 0;
    }

    case "stay": {
      await withSession(async (paw) => {
        await paw.eval("window.__paw && window.__paw.stay()");
      });
      console.log("stay: cursor will not rest. run `paw unstay` to re-enable.");
      await audit("stay");
      return 0;
    }

    case "unstay": {
      await withSession(async (paw) => {
        await paw.eval("window.__paw && window.__paw.unstay()");
      });
      console.log("unstay: cursor will rest after 5s idle.");
      await audit("unstay");
      return 0;
    }

    case "play": {
      // Minimal interactive mode: WASD walks the cursor, Space clicks the
      // nearest interactive element, Q (or Ctrl-C) quits. Holds ONE CDP
      // connection open for the whole session — unlike every other verb
      // which opens-acts-closes per command.
      if (!process.stdin.isTTY) {
        console.error("paw play: requires a TTY (run from interactive shell, not pipe)");
        return 1;
      }
      const s = loadState();
      const paw = await connect({ wsUrl: s.WS_URL });

      // Drain any HUMAN-TAKEOVER buffered before this session
      const humanEntries = await paw.drainHumanLog();
      for (const e of humanEntries) {
        await audit(`grab (${e.from.x},${e.from.y}) → (${e.to.x},${e.to.y})`, "HUMAN-TAKEOVER", e.endTs);
      }

      const step = flags.step ? parseInt(String(flags.step), 10) : 30;
      console.log(`paw play — WASD move (${step}px), Space click nearest, Q quit`);
      await audit(`play started (step=${step}px)`);

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      let busy = false;
      const quit = new Promise<void>((resolve) => {
        const onData = async (key: string) => {
          // Ctrl-C (0x03) or q/Q
          if (key === "\u0003" || key === "q" || key === "Q") {
            process.stdin.removeListener("data", onData);
            resolve();
            return;
          }
          if (busy) return;
          busy = true;
          try {
            let dx = 0, dy = 0;
            if (key === "w" || key === "W") dy = -step;
            else if (key === "s" || key === "S") dy = step;
            else if (key === "a" || key === "A") dx = -step;
            else if (key === "d" || key === "D") dx = step;
            else if (key === " ") {
              const list = await paw.nearby(200, 1);
              if (list.length) {
                const target = list[0];
                await paw.click(target.idx);
                await audit(`play click [${target.idx}] ${target.role} "${target.name.slice(0, 40)}"`);
                process.stdout.write(`\rclicked [${target.idx}] ${target.role} "${target.name.slice(0, 40)}"\n`);
              } else {
                process.stdout.write(`\rno interactive element within 200px\n`);
              }
              return;
            } else {
              return;
            }
            const r = await paw.moveBy(dx, dy);
            process.stdout.write(`\rcursor=(${Math.round(r.x)},${Math.round(r.y)})     `);
          } catch (e: any) {
            process.stdout.write(`\nerror: ${e.message ?? e}\n`);
          } finally {
            busy = false;
          }
        };
        process.stdin.on("data", onData);
      });

      await quit;
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.pause();
      await paw.close();
      console.log("\npaw play: exited");
      await audit("play ended");
      return 0;
    }

    default:
      console.error(`paw: unknown verb "${verb}". try \`paw help\`.`);
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
    console.error(`paw: ${e.message ?? e}`);
    process.exitCode = 1;
  });
