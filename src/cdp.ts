export interface CDPDiscoveryOptions {
  host?: string;
  port?: number;
  pageUrl?: string;
  pageIndex?: number;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class CDPClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(p: any) => void>>();
  private closed = false;

  static async discover(opts: CDPDiscoveryOptions = {}): Promise<CDPClient> {
    const target = await CDPClient.discoverTarget(opts);
    const c = new CDPClient();
    await c.openWS(target.webSocketDebuggerUrl);
    return c;
  }

  static async discoverTarget(opts: CDPDiscoveryOptions = {}): Promise<{ id: string; url: string; title: string; webSocketDebuggerUrl: string }> {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 9222;
    const res = await fetch(`http://${host}:${port}/json`);
    if (!res.ok) throw new Error(`paw: CDP discovery failed (${res.status}). Is Chrome running with --remote-debugging-port=${port}?`);
    const all = (await res.json()) as Array<{ id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }>;
    const pages = all.filter((p) => p.type === "page" && p.webSocketDebuggerUrl);
    if (!pages.length) throw new Error("paw: no debuggable page found");
    let target = pages[opts.pageIndex ?? 0];
    if (opts.pageUrl) {
      const m = pages.find((p) => p.url.includes(opts.pageUrl!));
      if (!m) throw new Error(`paw: no page matching "${opts.pageUrl}"`);
      target = m;
    }
    return target;
  }

  static async attach(wsUrl: string): Promise<CDPClient> {
    const c = new CDPClient();
    await c.openWS(wsUrl);
    return c;
  }

  private openWS(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", (e) => reject(new Error("paw: WebSocket error")), { once: true });
      this.ws.addEventListener("close", () => {
        this.closed = true;
        this.pending.forEach((p) => p.reject(new Error("paw: CDP socket closed")));
        this.pending.clear();
      });
      this.ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (typeof msg.id === "number") {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(`${msg.error.message ?? "CDP error"} (${msg.error.code ?? "?"})`));
          else pending.resolve(msg.result);
        } else if (typeof msg.method === "string") {
          const set = this.listeners.get(msg.method);
          if (set) set.forEach((fn) => fn(msg.params));
        }
      });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("paw: CDP socket closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.ws.addEventListener("close", () => resolve(), { once: true });
      this.ws.close();
    });
  }
}
