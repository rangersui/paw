# PAW

> **Physical Agent Worker.** AI's body on the web — a visible cursor that walks, clicks, and types under AI control, with a real mouse you can grab (Alt+drag) to redirect mid-task. Human sees what AI does; AI sees what human just did.

```bash
npm i -g paw-browser
paw start brave --url https://example.com
paw click 1
```

```
curl = Client URL              (1996, HTTP's remote control)
paw  = Physical Agent Worker   (2026, the AI's body in the browser)
```

**Zero runtime dependencies.** Node 22+. `dependencies: {}` — literally empty. Native `WebSocket`, no `ws`, no Playwright, no Puppeteer, no MCP, no browser download.

## Why

CDP is infrastructure — anyone can wrap it. PAW's three differentiators:

1. **Visible cursor / character** — trust through visibility. A human watching the screen can literally see what the AI is doing, action by action.
2. **Audit log** — every action is appended to `~/.pawprint` locally AND (optionally) PUT to an elastik URL as a tee for a reviewer agent.
3. **Human-in-the-loop shared control** — Alt+drag the cursor with your real mouse to redirect AI mid-task. AI commands automatically pause while you're holding the wheel; resume when you release.

`ghost-cursor` optimizes for "fool the website into thinking it's human". PAW optimizes for "let the human see exactly what the AI just did." Different goals, different cadence — PAW is deliberately slow (~1.4s per click by default) so the human can follow.

## Quick start

```bash
# 1. Auto-launch a Chromium-family browser with the debug port open
paw start brave --url https://example.com
# (also detects chrome / edge; pass --port to change from 9222)

# 2. See what's interactive on the page
paw snapshot
#   [1] link  More information...
#   [2] link  https://www.iana.org/domains/example

# 3. Drive
paw click 1                 # cursor walks bezier → highlight → press-shrink → real click → pause
paw hover 2
paw eval "document.title"
paw screenshot

# 4. Close session (browser keeps running)
paw close
```

## CLI verbs

### Session

| verb | what |
|---|---|
| `paw start [brave\|chrome\|edge] [--url U] [--port P]` | launch a browser with `--remote-debugging-port` and connect |
| `paw connect <port> [url-substring]` | connect to a Chromium already running with debug port; writes `~/.paw` |
| `paw close` | clear the session file |

### Perception

| verb | what |
|---|---|
| `paw snapshot` | numbered list of every interactive element on the page |
| `paw visible` | only elements currently in viewport (what the human sees) |
| `paw show <text\|sel>` | `scrollIntoView` a CSS selector OR a text substring (whitespace-normalized) |
| `paw nearby [--radius N] [--limit N]` | only elements within radius px of cursor — saves AI tokens |
| `paw text <n\|sel>` | `textContent` |
| `paw html [sel]` | `outerHTML`, defaults to whole document |
| `paw screenshot [path]` | PNG screenshot, default `./screenshot.png` |
| `paw position` / `paw box <sel>` | cursor xy / element bounding rect |

### Actions (animated by default)

| verb | what |
|---|---|
| `paw click <n\|sel> [--right\|--middle]` | bezier walk → outline highlight → press-shrink → real CDP mouse event → release → unhighlight → pause |
| `paw dblclick` / `paw rightclick` / `paw hover` | same envelope, different event |
| `paw type <n\|sel> <text\|@file\|->` | click into the input + `Input.insertText` (text can come from a file or stdin) |
| `paw keypress <key>` | `Enter`, `Tab`, `ArrowDown`, ... |
| `paw drag <from> <to>` | press → bezier walk dispatching mouseMoved with button held → release |
| `paw scroll <up\|down\|left\|right> [px]` | wheel events at cursor position |

### Cursor as a first-class object

Compose any motion AI's high-level verbs don't cover:

| verb | what |
|---|---|
| `paw move <x> <y>` | walk cursor to absolute viewport coordinates |
| `paw moveby <dx> <dy>` | relative offset from current cursor position |
| `paw press [--right\|--middle]` | mouseDown at current cursor position; sets a persistent press flag |
| `paw release` | mouseUp + clear the press flag |

Manual drag composed from primitives (the press flag persists across `paw` invocations via page-side state, so subsequent `paw move` dispatches `mouseMoved` with the button held):

```bash
paw move 100 305 && paw press
paw move 250 200            # cursor mid-drag — dragged element follows
paw move 350 200            # multi-segment OK
paw move 273 305
paw release
```

### Pass-through (no animation)

| verb | what |
|---|---|
| `paw goto <url>` | `Page.navigate` (waits for load) |
| `paw eval <expr\|@file.js\|->` | `Runtime.evaluate`; expression can come from a file or stdin |
| `paw wait <n\|sel>` | poll until selector/index present |
| `paw wait-idle [stableMs]` | block until the page's network has been quiet for N ms |
| `paw log [--since 5s] [--type T] [--status '>=N']` | dump page log (console + fetch + XHR + error events) |
| `paw dismiss-cookies [--reject\|--list]` | clicks Accept/Reject on 11 known CMPs (OneTrust, Cookiebot, Didomi, Quantcast, Usercentrics, CookieYes, TrustArc, Iubenda, Osano, Termly, Google FC) plus a generic text-button fallback |

### Batch & modes

| verb | what |
|---|---|
| `paw batch [@file\|-]` | run many verbs in one CDP session (no per-command WS setup overhead) |
| `paw stay` / `paw unstay` | pin the cursor in place (disable idle-rest) / re-enable |
| `paw auto` | info: auto mode is the default; this just prints a note |
| `paw play` | interactive WASD control — placeholder for v0.6 |

### Rules

- Target arg starting with a digit → snapshot/nearby index. Anything else → CSS selector.
- `@file.js` → read JS expression from a file. `-` → read from stdin.
- `--speed fast | normal | slow` or `PAW_SPEED=...` → global cadence preset (see below).
- `--renderer cursor | none` → swap renderer. `cursor` is default; `none` is equivalent to `--silent` (real CDP events fire, no visible cursor or highlight).
- `--silent` is shorthand for `--renderer none`.

## Cadence (the soul)

PAW is deliberately slow. Every animated verb runs a 7-phase envelope (~1.4s default):

```
move (400ms) → highlight (400ms) → press-shrink (80ms)
            ↓
     dispatch + press pause (150ms)
            ↓
release → press-restore (80+100ms) → unhighlight → observe (300ms)
```

| preset | total | for |
|---|---|---|
| `fast` | ~280ms | AI batch work |
| `normal` | ~1.4s | **default** — humans can follow along |
| `slow` | ~3.5s | demos / screen recording |

Override per call (`paw click 1 --speed fast`) or globally (`export PAW_SPEED=fast`).

## Audit log (the other soul)

Every state-changing verb is appended (sync, mode 0600) to `~/.pawprint`:

```
2026-05-11T09:15:32.198Z [AI] click [1] button "Click me" at (89,125)
2026-05-11T09:15:33.206Z [HUMAN-TAKEOVER] grab (89,125) → (340,200)
2026-05-11T09:15:34.412Z [AI] hover [4] clickable "Hover target A" at (114,239)
```

When the human Alt+drags the cursor, the takeover is buffered page-side and flushed into the audit log with a `[HUMAN-TAKEOVER]` tag on the next `paw` command. Reviewer agents tell autopilot from manual control at a glance — like the cockpit voice recorder distinguishing pilot inputs from autopilot.

If `PAW_ELASTIK=http://host:port` is set, every audit line is also PUT to `${PAW_ELASTIK}/home/pawprint/<iso-timestamp>` (fire-and-forget, max 500ms timeout). Any client can subscribe to `/listen/home/pawprint/*` for an SSE stream of every PAW action in real time:

```bash
curl -N http://localhost:3105/listen/home/pawprint/*
```

| env var | purpose |
|---|---|
| `PAW_ELASTIK` | elastik base URL |
| `PAW_ELASTIK_TOKEN` or `ELASTIK_WRITE_TOKEN` | write auth |
| `PAW_NO_AUDIT=1` | disable both local and remote audit |

## State file

`~/.paw` — KEY=VALUE plain text, shell-sourceable, no JSON envelope:

```
HOST=127.0.0.1
PORT=9222
WS_URL=ws://127.0.0.1:9222/devtools/page/4E3E8BBD04CC94B74E7CB327212DC10E
PAGE_URL=https://example.com
TITLE=Example Domain
```

## Renderer interface

```ts
interface Renderer {
  install(): Promise<void>;
  position(): Pt;
  moveTo(target: Pt, opts?: ...): Promise<void>;
  highlight(target: string | number, color?: string): Promise<void>;
  unhighlight(): Promise<void>;
  pressScale(scale: number, durMs: number): Promise<void>;
  flash(): Promise<void>;
}
```

v1.0 ships one impl: `CursorRenderer` — a black-outlined SVG arrow injected via `Runtime.evaluate`, animated via CSS `@keyframes` built from a quadratic bezier path, with element-outline highlight and cursor scale-shrink on press. Future renderers (`pet` / `highlight` / `platform`) will drop in via the same interface without changing the CLI.

## Live HTML REPL with elastik

The defining use case isn't automating other people's sites — it's authoring your own. PAW + elastik gives you a live HTML REPL where the URL IS the source of truth:

```bash
# 1. seed a blank canvas at a URL
curl -X PUT $ELASTIK/home/canvas.html \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/html" \
  --data '<!doctype html><html><body></body></html>'

# 2. point paw at it
paw goto $ELASTIK/home/canvas.html

# 3. AI rewrites the entire DOM via paw eval (CSS + HTML + <script>)
paw eval - <<'JS'
  document.head.innerHTML = '<title>my app</title><style>...</style>';
  document.body.innerHTML = '<h1>...</h1><button id="x">click</button><script>...</script>';
JS

# 4. PUT the live DOM back — URL becomes the new source of truth
paw eval - <<'JS'
  const html = '<!doctype html>\n' + document.documentElement.outerHTML;
  await fetch('/home/canvas.html', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'text/html' },
    body: html,
  });
JS
```

After step 4, `curl $ELASTIK/home/canvas.html` returns the new page. Any browser opening that URL gets the AI-built interactive app, fully self-contained — because `documentElement.outerHTML` serializes `<script>` tags verbatim. Multiple tabs subscribed via `EventSource('/listen/home/canvas.html')` get every PUT pushed in real time with an etag for change detection.

No build step. No deploy. No framework. No database. The HTML *is* the artifact, the URL *is* the publish target, the browser *is* the editor.

## Acknowledgments

PAW stands on the work of these projects. Each shaped a piece of the architecture:

- [**sids/cdp-browser**](https://github.com/sids/cdp-browser) — established the precedent of a small, native-WebSocket CDP CLI for AI agents. PAW's connection shape and the `dismiss-cookies` verb draw on its design.
- [**Xetera/ghost-cursor**](https://github.com/Xetera/ghost-cursor) — the canonical reference for bezier path generation in cursor automation. PAW inverts the goal (visible rather than evasive) but uses the same underlying curve math.
- **Shimeji** — the desktop-pet pattern of a character with physics that walks across UI surfaces and is grabbable by the user's real mouse. Reserved as inspiration for the v1.4 `PlatformRenderer`.
- [**elastik V6**](https://github.com/rangersui/Elastik) — the 6-verb HTTP byte engine that serves as PAW's optional audit backend and persistence layer for the live-HTML-REPL workflow.

## Roadmap

```
v1.0  ✓ CursorRenderer + 30+ verbs + audit (~/.pawprint) + snapshot
       Alt+drag handoff + [AI]/[HUMAN-TAKEOVER] tags + viewport-shared-truth (visible/show)

v1.1    move/moveby/press/release primitives polish
v1.2    PetRenderer — sprite-sheet animation (walk/hammer/pen/magnifier/broom/camera)
v1.3    multi-Renderer real switching via --renderer pet|highlight|platform|none
v1.4    PlatformRenderer — Shimeji-style physics; cursor walks on DOM platforms
v1.5    paw play — interactive WASD takeover mode
v1.6    speculative prefetch — idle cursor patrols the page caching coordinates
```

## Philosophy

```
curl is HTTP's remote control      (1996)
paw  is the browser's body         (2026)
       Physical Agent Worker

the page is the level
DOM elements are NPCs
the AI is the soul
the cursor is the body
CDP is the nervous system
physics (v1.4+) is the world's rules
the human is the occasional god-hand that grabs the wheel
```

## License

MIT
