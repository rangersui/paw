import { homedir } from "node:os";
import { appendFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

export const LOG_FILE = join(homedir(), ".pet-cursor.log");

const ELASTIK_TIMEOUT_MS = 500;

function truncate(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

export async function audit(line: string): Promise<void> {
  if (process.env.PET_NO_AUDIT) return;
  const ts = new Date().toISOString();
  const entry = `${ts} ${truncate(line, 500)}\n`;

  // local file — sync, guaranteed before process exit
  try {
    const fresh = !existsSync(LOG_FILE);
    appendFileSync(LOG_FILE, entry);
    if (fresh) {
      try { chmodSync(LOG_FILE, 0o600); } catch {}
    }
  } catch {}

  // elastik — fire-and-forget, race against a wall-clock timeout (no
  // AbortController: Node 22 fetch + abort + process.exit race causes a
  // libuv assertion on Windows. Leaked fetch settles in background; we
  // just don't block the main thread waiting for it.
  const elastik = process.env.PET_ELASTIK;
  if (elastik) {
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    const token = process.env.PET_ELASTIK_TOKEN || process.env.ELASTIK_WRITE_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // PUT (not POST) — each audit entry is a fresh world at a unique
    // timestamp path. PUT creates-or-replaces; POST appends-to-existing
    // and 404s when the path is new (elastik V6 semantics).
    // /home/log/pet/* — elastik V6 only allows writes under valid path
    // prefixes (/home /etc /lib /boot /usr /var /tmp /dev /sys). /var is a
    // system world that requires the approve token; /home only needs write
    // token. /log/* (no prefix) gets a flat 404.
    const fetchP = fetch(`${elastik.replace(/\/$/, "")}/home/log/pet/${ts}`, {
      method: "PUT",
      body: line,
      headers,
    }).catch(() => null);
    const timeoutP = new Promise((r) => setTimeout(r, ELASTIK_TIMEOUT_MS));
    await Promise.race([fetchP, timeoutP]);
  }
}

export function fmtTarget(t: string | number): string {
  return typeof t === "number" ? `[${t}]` : t;
}

export async function describeTarget(
  resolve: (n: number) => Promise<{ role: string; name: string } | null>,
  t: string | number,
): Promise<string> {
  if (typeof t === "number") {
    try {
      const e = await resolve(t);
      if (e) return `[${t}] ${e.role} "${truncate(e.name, 40)}"`;
    } catch {}
    return `[${t}]`;
  }
  return t;
}
