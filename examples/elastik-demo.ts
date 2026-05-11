/**
 * End-to-end demo against the local elastik playground:
 *   1. PUT a rich HTML test world to http://127.0.0.1:3105/petcursor/demo.html
 *   2. Spawn a Chromium-family browser with --remote-debugging-port=9222 at that URL
 *   3. Connect paw over CDP and run through every visualized action
 *
 * Run:  ELASTIK_WRITE_TOKEN=... node examples/elastik-demo.js
 * (after `npm run build`)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../src";

const ELASTIK_URL = process.env.ELASTIK_URL ?? "http://127.0.0.1:3105";
const TOKEN = process.env.ELASTIK_WRITE_TOKEN;
const BROWSER =
  process.env.PAW_BROWSER ??
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const CDP_PORT = 9222;
const PAGE_PATH = "/petcursor/demo.html";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>paw demo</title>
<style>
  body { font: 16px system-ui; margin: 0; padding: 40px; background: #fafafa; color: #222; }
  h1 { margin: 0 0 24px; }
  .row { display: flex; gap: 16px; margin: 16px 0; align-items: center; }
  button { padding: 12px 20px; font-size: 15px; border: 0; border-radius: 6px;
           background: #2563eb; color: white; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  input { padding: 10px 12px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; min-width: 260px; }
  .menu { background: #fff; padding: 12px 18px; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,.08); cursor: pointer; }
  .menu:hover { background: #eef2ff; }
  .filler { height: 600px; background: linear-gradient(#fff, #e5e7eb); border-radius: 8px; margin: 24px 0; padding: 16px; }
  #log { background: #111; color: #6ee7b7; padding: 14px; border-radius: 6px; font-family: monospace; min-height: 80px; white-space: pre-wrap; }
  .card { display: inline-block; padding: 18px 24px; background: #fde68a; border-radius: 8px; cursor: grab; user-select: none; }
  .bin { display: inline-block; padding: 18px 24px; background: #fecaca; border-radius: 8px; min-width: 120px; text-align: center; }
</style></head>
<body>
  <h1>paw visual test</h1>

  <div class="row">
    <button id="hello">Click me</button>
    <button id="bye">Or me</button>
    <span id="counter">clicks: 0</span>
  </div>

  <div class="row">
    <input id="email" placeholder="type something here" />
    <span id="echo"></span>
  </div>

  <div class="row">
    <span class="menu" id="menu1">Hover target A</span>
    <span class="menu" id="menu2">Hover target B</span>
    <span id="hovered">hovered: -</span>
  </div>

  <div class="row">
    <span class="card" id="card" draggable="false">drag me →</span>
    <span class="bin" id="bin">drop here</span>
  </div>

  <div id="log">log:\n</div>

  <div class="filler">scroll down past this big block to test wheel events</div>
  <div class="filler" id="bottom">if you can read this, scroll worked</div>

  <script>
    const log = (m) => { const el = document.getElementById('log'); el.textContent += m + '\\n'; };
    let n = 0;
    document.getElementById('hello').onclick = () => { n++; document.getElementById('counter').textContent = 'clicks: ' + n; log('clicked hello'); };
    document.getElementById('bye').onclick = () => { n++; document.getElementById('counter').textContent = 'clicks: ' + n; log('clicked bye'); };
    document.getElementById('email').oninput = (e) => { document.getElementById('echo').textContent = e.target.value; };
    document.getElementById('menu1').onmouseenter = () => { document.getElementById('hovered').textContent = 'hovered: A'; };
    document.getElementById('menu2').onmouseenter = () => { document.getElementById('hovered').textContent = 'hovered: B'; };
    const card = document.getElementById('card'), bin = document.getElementById('bin');
    let dragging = false, sx = 0, sy = 0, baseX = 0, baseY = 0;
    card.addEventListener('mousedown', (e) => {
      dragging = true;
      // Parse existing transform so successive drags accumulate from the
      // current position instead of overwriting (otherwise each drag resets
      // the card to original CSS coords plus only the latest delta).
      const m = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(card.style.transform);
      baseX = m ? parseFloat(m[1]) : 0;
      baseY = m ? parseFloat(m[2]) : 0;
      sx = e.clientX; sy = e.clientY;
      card.style.zIndex = 1000;
      log('drag start');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      card.style.transform = 'translate(' + (baseX + e.clientX - sx) + 'px,' + (baseY + e.clientY - sy) + 'px)';
    });
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      const br = bin.getBoundingClientRect();
      if (e.clientX >= br.left && e.clientX <= br.right && e.clientY >= br.top && e.clientY <= br.bottom) {
        log('drag dropped on bin');
        bin.textContent = 'CAUGHT IT';
        bin.style.background = '#86efac';
      } else {
        log('drag missed bin (cursor at ' + e.clientX + ',' + e.clientY + ' bin at ' + br.left + '-' + br.right + ',' + br.top + '-' + br.bottom + ')');
      }
    });
  </script>
</body></html>`;

async function putHtml(): Promise<string> {
  if (!TOKEN) throw new Error("ELASTIK_WRITE_TOKEN env required (see Elastik-playground/.env)");
  const url = ELASTIK_URL + PAGE_PATH;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/html" },
    body: HTML,
  });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status} ${res.statusText}`);
  console.log(`✓ PUT ${url} (${res.status})`);
  return url;
}

async function waitForCDP(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`paw: CDP port ${port} did not come up within ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function probeCDP(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  const pageUrl = await putHtml();

  if (await probeCDP(CDP_PORT)) {
    console.log(`✓ reusing existing CDP on ${CDP_PORT}`);
  } else {
    const userDataDir = mkdtempSync(join(tmpdir(), "paw-cursor-"));
    console.log(`✓ launching ${BROWSER} on port ${CDP_PORT}`);
    const child = spawn(
      BROWSER,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=BraveRewards,BraveWallet,BraveAds",
        pageUrl,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    await waitForCDP(CDP_PORT);
    console.log(`✓ CDP up on ${CDP_PORT}`);
  }

  const paw = await connect({ port: CDP_PORT });
  console.log("→ navigating to fresh demo HTML");
  await paw.goto(pageUrl);
  console.log("✓ paw attached, starting demo in 1s...");
  await sleep(1000);

  console.log("→ click #hello");
  await paw.click("#hello");
  await sleep(400);

  console.log("→ click #bye");
  await paw.click("#bye");
  await sleep(400);

  console.log("→ hover #menu1");
  await paw.hover("#menu1");
  await sleep(500);

  console.log("→ hover #menu2");
  await paw.hover("#menu2");
  await sleep(500);

  console.log("→ type into #email");
  await paw.type("#email", "hello paw-cursor");
  await sleep(500);

  console.log("→ scroll down");
  await paw.scroll("down", 500);
  await sleep(700);

  console.log("→ scroll up");
  await paw.scroll("up", 500);
  await sleep(700);

  console.log("→ drag #card → #bin");
  await paw.drag("#card", "#bin");
  await sleep(800);

  const counter = await paw.text("#counter");
  const log = await paw.text("#log");
  console.log(`\nfinal counter: ${counter}`);
  console.log(`page log:\n${log}`);

  console.log("\n✓ done. browser stays open so you can poke at it. ctrl+c to exit.");
  await paw.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
