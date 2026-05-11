import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const STATE_FILE = join(homedir(), ".paw");

export interface State {
  HOST: string;
  PORT: string;
  WS_URL: string;
  PAGE_URL?: string;
  TITLE?: string;
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`paw: no session. run \`paw connect <port>\` first.`);
  }
  const raw = readFileSync(STATE_FILE, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  if (!out.WS_URL) throw new Error(`paw: malformed state at ${STATE_FILE} — missing WS_URL`);
  return out as unknown as State;
}

export function saveState(s: State): void {
  const lines = [
    `# paw session — written by \`paw connect\``,
    `HOST=${s.HOST}`,
    `PORT=${s.PORT}`,
    `WS_URL=${s.WS_URL}`,
  ];
  if (s.PAGE_URL) lines.push(`PAGE_URL=${s.PAGE_URL}`);
  if (s.TITLE) lines.push(`TITLE=${s.TITLE}`);
  lines.push("");
  writeFileSync(STATE_FILE, lines.join("\n"), "utf8");
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {}
}

export function clearState(): void {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}
