import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const WIN_PATHS: Record<string, string[]> = {
  brave: [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe",
  ],
  chrome: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  edge: [
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ],
};

const MAC_PATHS: Record<string, string[]> = {
  brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
};

const LINUX_NAMES: Record<string, string[]> = {
  brave: ["brave-browser", "brave"],
  chrome: ["google-chrome", "chrome", "chromium-browser", "chromium"],
  edge: ["microsoft-edge"],
};

export function findBrowser(hint?: string): { binary: string; brand: string } | null {
  const order = hint ? [hint] : ["brave", "chrome", "edge"];
  const plat = platform();
  for (const brand of order) {
    if (plat === "win32") {
      for (const p of WIN_PATHS[brand] || []) if (existsSync(p)) return { binary: p, brand };
    } else if (plat === "darwin") {
      for (const p of MAC_PATHS[brand] || []) if (existsSync(p)) return { binary: p, brand };
    } else {
      for (const name of LINUX_NAMES[brand] || []) {
        const candidates = [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/snap/bin/${name}`];
        for (const c of candidates) if (existsSync(c)) return { binary: c, brand };
      }
    }
  }
  return null;
}

export async function waitForCDP(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`paw: CDP port ${port} did not come up within ${timeoutMs}ms`);
}

export interface LaunchOptions {
  port?: number;
  url?: string;
  browser?: string;
  profileDir?: string;
}

export async function launch(opts: LaunchOptions = {}): Promise<{ binary: string; brand: string; port: number }> {
  const port = opts.port ?? 9222;
  const url = opts.url ?? "about:blank";
  const found = findBrowser(opts.browser);
  if (!found) throw new Error("paw: no Chromium-family browser found. install brave/chrome/edge, or pass --browser=<name>.");
  const profileDir = opts.profileDir ?? join(homedir(), ".paw-profile");
  const child = spawn(
    found.binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Animation-friendliness flags — so CSS animations keep running when the
      // browser window is in the background (e.g. terminal has focus).
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=BraveRewards,BraveWallet,BraveAds,IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  await waitForCDP(port);
  return { binary: found.binary, brand: found.brand, port };
}
