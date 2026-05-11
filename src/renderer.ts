import { CDPClient } from "./cdp";
import { bezierPath, Pt } from "./bezier";

// Arrow tip anchored at (0, 0) of the viewBox so translate(x, y) places the
// pointer tip exactly at viewport (x, y) — matches where Input.dispatchMouseEvent
// fires. Previous path had M3,2 which gave a ~4px diagonal offset between the
// visible arrow tip and the real click point, most visible during drag where the
// dragged element follows the real coords but the eye follows the arrow tip.
const DEFAULT_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path d="M0 0 L0 17 L5 12 L8 20 L11 19 L8 11 L15 11 Z" fill="black" stroke="white" stroke-width="1"/></svg>`;
export const DEFAULT_CURSOR =
  "data:image/svg+xml;base64," + Buffer.from(DEFAULT_CURSOR_SVG).toString("base64");

const BINDING = "__petArrived";
const SCRIPT_VERSION = 14;
const IDLE_MS = 5000;
const CORNER_PAD = 24;

const PAGE_SCRIPT = `
(() => {
  if (window.__pet && window.__pet.v === ${SCRIPT_VERSION}) return;
  const ID = '__pet_cursor__';
  const STYLE_ID = '__pet_style__';
  let restTimer = null;
  let lastSrc = '', lastSize = 32;
  function clearRest() { if (restTimer) { clearTimeout(restTimer); restTimer = null; } }
  function scheduleRest() {
    clearRest();
    if (window.__pet_no_rest) return;
    restTimer = setTimeout(rest, ${IDLE_MS});
  }
  function stay() { window.__pet_no_rest = true; clearRest(); }
  function unstay() { window.__pet_no_rest = false; scheduleRest(); }
  function corner() {
    return { x: (window.innerWidth || 1024) - ${CORNER_PAD}, y: ${CORNER_PAD} };
  }
  function clampPos(x, y) {
    const s = lastSize || 32;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    return { x: Math.max(0, Math.min(vw - s, x)), y: Math.max(0, Math.min(vh - s, y)) };
  }
  function bp(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const px = -dy / d, py = dx / d;
    const off = (Math.random() - 0.5) * d * 0.3;
    const cx = mx + px * off, cy = my + py * off;
    const out = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, u = 1 - t;
      out.push({ x: u*u*a.x + 2*u*t*cx + t*t*b.x, y: u*u*a.y + 2*u*t*cy + t*t*b.y });
    }
    return out;
  }
  function ensure(src, size) {
    if (src) lastSrc = src;
    if (size) lastSize = size;
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('img');
      el.id = ID;
      el.src = src || lastSrc;
      const p = window.__pet_pos || { x: 0, y: 0 };
      const sc = window.__pet_resting ? 0.5 : 1;
      el.style.cssText = 'position:fixed;left:0;top:0;width:' + (size || lastSize) + 'px;height:' + (size || lastSize) + 'px;pointer-events:none;z-index:2147483647;transform:translate(' + p.x + 'px,' + p.y + 'px) scale(' + sc + ');will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));';
      (document.body || document.documentElement).appendChild(el);
    } else if (src && el.src !== src) {
      el.src = src;
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    return { el: el, style: style };
  }
  function animate(token, src, size, path, duration) {
    clearRest();
    const wasResting = window.__pet_resting === true;
    window.__pet_resting = false;
    const r = ensure(src, size);
    // Clamp every waypoint to viewport so the cursor can't leave the screen.
    // If the caller passed an off-screen target, the cursor slides along the
    // edge instead of vanishing into the void.
    const clamped = path.map(function (p) { return clampPos(p.x, p.y); });
    const name = '__pet_move_' + token;
    const frames = clamped.map(function (p, i) {
      const t = i / (clamped.length - 1);
      const pct = (t * 100).toFixed(2);
      const sc = wasResting ? (0.5 + 0.5 * Math.min(1, t * 2)) : 1;
      return pct + '% { transform: translate(' + p.x + 'px,' + p.y + 'px) scale(' + sc + '); }';
    }).join(' ');
    r.style.textContent = '@keyframes ' + name + ' { ' + frames + ' }';
    r.el.style.animation = 'none';
    void r.el.offsetWidth;
    r.el.style.animation = name + ' ' + duration + 'ms cubic-bezier(.4,0,.2,1) forwards';
    function done() {
      r.el.removeEventListener('animationend', done);
      const last = clamped[clamped.length - 1];
      r.el.style.animation = 'none';
      r.el.style.transform = 'translate(' + last.x + 'px,' + last.y + 'px) scale(1)';
      window.__pet_pos = { x: last.x, y: last.y };
      if (typeof window['${BINDING}'] === 'function') window['${BINDING}'](token);
      scheduleRest();
    }
    r.el.addEventListener('animationend', done);
  }
  function rest() {
    restTimer = null;
    const cur = window.__pet_pos || { x: 0, y: 0 };
    const c = corner();
    const r = ensure('', 0);
    if (Math.hypot(cur.x - c.x, cur.y - c.y) < 4) {
      r.el.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(0.5)';
      window.__pet_pos = c;
      window.__pet_resting = true;
      return;
    }
    const path = bp(cur, c);
    const name = '__pet_rest_' + Date.now();
    const frames = path.map(function (p, i) {
      const t = i / (path.length - 1);
      const pct = (t * 100).toFixed(2);
      const sc = 1 - 0.5 * t;
      return pct + '% { transform: translate(' + p.x + 'px,' + p.y + 'px) scale(' + sc + '); }';
    }).join(' ');
    r.style.textContent = '@keyframes ' + name + ' { ' + frames + ' }';
    r.el.style.animation = 'none';
    void r.el.offsetWidth;
    r.el.style.animation = name + ' 600ms ease-out forwards';
    function done() {
      r.el.removeEventListener('animationend', done);
      r.el.style.animation = 'none';
      r.el.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(0.5)';
      window.__pet_pos = c;
      window.__pet_resting = true;
    }
    r.el.addEventListener('animationend', done);
  }
  function flash(token, src, size) {
    clearRest();
    const r = ensure(src || '', size || 32);
    const ring = document.createElement('div');
    const p = window.__pet_pos || { x: 0, y: 0 };
    ring.style.cssText = 'position:fixed;left:' + p.x + 'px;top:' + p.y + 'px;width:24px;height:24px;border:2px solid #ff5252;border-radius:50%;pointer-events:none;z-index:2147483646;transform:translate(-12px,-12px) scale(.4);opacity:1;transition:transform 280ms ease-out,opacity 280ms ease-out;';
    document.body.appendChild(ring);
    requestAnimationFrame(function(){ ring.style.transform = 'translate(-12px,-12px) scale(2)'; ring.style.opacity = '0'; });
    setTimeout(function(){ ring.remove(); if (typeof window['${BINDING}'] === 'function') window['${BINDING}'](token); scheduleRest(); }, 300);
  }
  window.addEventListener('resize', function () {
    if (window.__pet_resting) {
      const c = corner();
      const el = document.getElementById(ID);
      if (el) el.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(0.5)';
      window.__pet_pos = c;
    }
  }, { passive: true });

  // ─── human-grab affordance: Alt+drag the cursor with the real mouse ───
  // The cursor stays pointer-events:none so it doesn't block page clicks.
  // We listen globally for Alt+mousedown; if the mouse coords are inside
  // the cursor's bbox, we capture into a manual-drag loop until mouseup.
  // Shimeji-style direct manipulation, but gated on Alt so normal browsing
  // (including text selection with Shift) is undisturbed.
  let grabbing = false;
  function setHighlightOn(on) {
    const el = document.getElementById(ID);
    if (!el) return;
    el.style.outline = on ? '2px solid #3b82f6' : '';
    el.style.outlineOffset = on ? '2px' : '';
  }
  window.addEventListener('keydown', function (e) { if (e.altKey && !grabbing) setHighlightOn(true); });
  window.addEventListener('keyup', function (e) { if (!e.altKey && !grabbing) setHighlightOn(false); });
  window.addEventListener('mousedown', function (e) {
    if (!e.altKey) return;
    const el = document.getElementById(ID);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) return;
    e.preventDefault();
    e.stopPropagation();
    grabbing = true;
    window.__pet_human_grabbing = true;  // signals AI to wait
    clearRest();
    setHighlightOn(true);
    const startMouse = { x: e.clientX, y: e.clientY };
    const startCursor = window.__pet_pos || { x: 0, y: 0 };
    const startTs = new Date().toISOString();
    function onMove(ev) {
      const c = clampPos(startCursor.x + ev.clientX - startMouse.x, startCursor.y + ev.clientY - startMouse.y);
      el.style.animation = 'none';
      el.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(1)';
      window.__pet_pos = c;
      window.__pet_resting = false;
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      grabbing = false;
      window.__pet_human_grabbing = false;
      setHighlightOn(false);
      // Buffer the takeover for the next pet command to flush into the audit log
      const endPos = window.__pet_pos || { x: 0, y: 0 };
      window.__pet_human_log = window.__pet_human_log || [];
      window.__pet_human_log.push({
        ts: startTs,
        endTs: new Date().toISOString(),
        from: { x: Math.round(startCursor.x), y: Math.round(startCursor.y) },
        to: { x: Math.round(endPos.x), y: Math.round(endPos.y) },
      });
      scheduleRest();
    }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);

  // ─── log buffer + network counter (monkey-patch, page-side) ───
  function installLog() {
    if (window.__pet_log_installed) return;
    window.__pet_log_installed = true;
    window.__pet_log = window.__pet_log || [];
    window.__pet_inflight = 0;
    const MAX = 2000;
    function push(rec) {
      rec.t = Date.now();
      window.__pet_log.push(rec);
      if (window.__pet_log.length > MAX) window.__pet_log.shift();
    }
    ['log','info','warn','error','debug'].forEach(function (lvl) {
      const orig = console[lvl];
      console[lvl] = function () {
        try {
          const args = Array.prototype.slice.call(arguments).map(function (a) {
            if (a === null || a === undefined) return String(a);
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return '[object]'; } }
            return String(a);
          });
          push({ kind: 'console', level: lvl, msg: args.join(' ') });
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
    const oFetch = window.fetch;
    if (oFetch) {
      window.fetch = function (input, init) {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
        const t0 = Date.now();
        window.__pet_inflight++;
        return oFetch.apply(this, arguments).then(function (res) {
          push({ kind: 'net', method: method, url: url, status: res.status, ms: Date.now() - t0 });
          window.__pet_inflight--;
          return res;
        }, function (err) {
          push({ kind: 'net', method: method, url: url, status: 0, err: String(err), ms: Date.now() - t0 });
          window.__pet_inflight--;
          throw err;
        });
      };
    }
    const XP = XMLHttpRequest.prototype;
    const oOpen = XP.open, oSend = XP.send;
    XP.open = function (m, u) { this.__pet_m = m; this.__pet_u = u; return oOpen.apply(this, arguments); };
    XP.send = function () {
      const t0 = Date.now();
      const self = this;
      window.__pet_inflight++;
      this.addEventListener('loadend', function () {
        push({ kind: 'net', method: self.__pet_m || 'GET', url: self.__pet_u || '', status: self.status, ms: Date.now() - t0 });
        window.__pet_inflight--;
      });
      return oSend.apply(this, arguments);
    };
    window.addEventListener('error', function (e) {
      push({ kind: 'error', msg: String(e.message || e), file: e.filename || '', line: e.lineno || 0 });
    });
    window.addEventListener('unhandledrejection', function (e) {
      push({ kind: 'error', msg: 'unhandled rejection: ' + String(e.reason && e.reason.message || e.reason) });
    });
  }
  installLog();

  // ─── cookie banner dismisser ───
  const CMP = [
    { name: 'OneTrust', accept: '#onetrust-accept-btn-handler', reject: '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler' },
    { name: 'Cookiebot', accept: '#CybotCookiebotDialogBodyButtonAccept, #CybotCookiebotDialogBodyLevelButtonAcceptAll', reject: '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonReject' },
    { name: 'Didomi', accept: '#didomi-notice-agree-button', reject: '#didomi-notice-disagree-button' },
    { name: 'Quantcast', accept: '.qc-cmp2-summary-buttons button[mode="primary"]', reject: '.qc-cmp2-summary-buttons button[mode="secondary"]' },
    { name: 'Usercentrics', accept: '[data-testid="uc-accept-all-button"]', reject: '[data-testid="uc-deny-all-button"]' },
    { name: 'CookieYes', accept: '.cky-btn-accept', reject: '.cky-btn-reject' },
    { name: 'TrustArc', accept: '#truste-consent-button', reject: '#truste-consent-required' },
    { name: 'Iubenda', accept: '.iubenda-cs-accept-btn', reject: '.iubenda-cs-reject-btn' },
    { name: 'Osano', accept: '.osano-cm-accept-all', reject: '.osano-cm-deny-all' },
    { name: 'Termly', accept: '.t-acceptAllButton', reject: '.t-declineAllButton' },
    { name: 'Google FC', accept: '.fc-cta-consent', reject: '.fc-cta-do-not-consent' },
  ];
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function dismissCookies(action) {
    const out = { matched: null, clicked: false, candidates: [] };
    for (let i = 0; i < CMP.length; i++) {
      const sel = action === 'reject' ? CMP[i].reject : CMP[i].accept;
      if (!sel) continue;
      const el = document.querySelector(sel);
      if (el && visible(el)) {
        out.matched = CMP[i].name;
        if (action !== 'list') { try { el.click(); out.clicked = true; } catch (e) {} }
        else out.candidates.push(CMP[i].name);
        if (action !== 'list') return out;
      } else if (el) {
        out.candidates.push(CMP[i].name + ' (hidden)');
      }
    }
    if (action !== 'list' && !out.matched) {
      const btns = document.querySelectorAll('button, [role="button"], a');
      const rx = /^(accept|agree|allow|got it|ok|sounds good|i agree)( all)?$/i;
      for (let i = 0; i < btns.length; i++) {
        const t = (btns[i].textContent || '').trim();
        if (rx.test(t) && visible(btns[i])) {
          out.matched = 'generic("' + t + '")';
          try { btns[i].click(); out.clicked = true; } catch (e) {}
          return out;
        }
      }
    }
    return out;
  }
  function snapshot() {
    const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role], [tabindex]:not([tabindex="-1"]), [onclick], [contenteditable="true"]';
    const seen = new Set();
    const out = [null];
    const els = [null];
    const direct = Array.from(document.querySelectorAll(sel));
    const pointers = Array.from(document.querySelectorAll('*')).filter(function (el) {
      if (direct.indexOf(el) >= 0) return false;
      const c = getComputedStyle(el).cursor;
      return c === 'pointer' || c === 'grab' || c === 'grabbing';
    });
    direct.concat(pointers).forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
      if (el.disabled) return;
      let role = el.getAttribute('role');
      if (!role) {
        const tag = el.tagName.toLowerCase();
        const t = (el.type || '').toLowerCase();
        if (tag === 'a') role = 'link';
        else if (tag === 'button') role = 'button';
        else if (tag === 'input') {
          if (t === 'submit' || t === 'button' || t === 'reset') role = 'button';
          else if (t === 'checkbox' || t === 'radio' || t === 'file' || t === 'color' || t === 'range') role = t;
          else role = 'input';
        }
        else if (tag === 'textarea') role = 'textarea';
        else if (tag === 'select') role = 'select';
        else if (tag === 'summary') role = 'disclosure';
        else role = (cs.cursor === 'grab' || cs.cursor === 'grabbing') ? 'draggable' : 'clickable';
      }
      let name = el.getAttribute('aria-label') || '';
      if (!name && el.getAttribute('aria-labelledby')) {
        const ref = document.getElementById(el.getAttribute('aria-labelledby'));
        if (ref) name = (ref.textContent || '').trim();
      }
      if (!name) name = (el.placeholder || el.value || (el.textContent || '').trim() || el.alt || el.title || '');
      name = name.replace(/\\s+/g, ' ').trim();
      if (name.length > 80) name = name.slice(0, 77) + '...';
      const vh = window.innerHeight, vw = window.innerWidth;
      const offscreen = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
      out.push({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
        role: role,
        name: name,
        offscreen: offscreen,
      });
      els.push(el);
    });
    window.__pet_snapshot = out;
    window.__pet_snapshot_els = els;
    scheduleRest();
    return out;
  }
  function nearby(radius, limit) {
    scheduleRest();
    if (!window.__pet_snapshot) snapshot();
    const cur = window.__pet_pos || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const R = radius || 200;
    const L = limit || 12;
    const snap = window.__pet_snapshot || [];
    const out = [];
    for (let i = 1; i < snap.length; i++) {
      const e = snap[i];
      if (!e) continue;
      const d = Math.hypot(e.x - cur.x, e.y - cur.y);
      if (d <= R) {
        out.push({ idx: i, role: e.role, name: e.name, x: e.x, y: e.y, dist: d, offscreen: e.offscreen });
      }
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out.slice(0, L);
  }
  function _live(el) {
    if (!el || !el.isConnected) return null;
    let r = el.getBoundingClientRect();
    let cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (cx < 0 || cx > vw || cy < 0 || cy > vh) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    if (r.width < 1 || r.height < 1) return null;
    return { x: cx, y: cy };
  }
  function liveCenter(n) {
    const arr = window.__pet_snapshot_els;
    return _live(arr && arr[n]);
  }
  function liveSel(sel) {
    try { return _live(document.querySelector(sel)); } catch (e) { return null; }
  }
  function resolveEl(target) {
    if (typeof target === 'number') {
      const arr = window.__pet_snapshot_els;
      return (arr && arr[target]) || null;
    }
    try { return document.querySelector(target); } catch (e) { return null; }
  }
  // ─── visual ceremony: highlight target, press-down cursor scale ───
  function highlight(target, color) {
    unhighlight();
    const el = resolveEl(target);
    if (!el) return false;
    window.__pet_hl_el = el;
    window.__pet_hl_prev = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      transition: el.style.transition,
    };
    el.style.transition = 'outline-color 120ms ease-out';
    el.style.outline = '3px solid ' + (color || '#3ddc84');
    el.style.outlineOffset = '2px';
    return true;
  }
  function unhighlight() {
    const el = window.__pet_hl_el;
    if (!el) return;
    const p = window.__pet_hl_prev || {};
    el.style.outline = p.outline || '';
    el.style.outlineOffset = p.outlineOffset || '';
    el.style.transition = p.transition || '';
    window.__pet_hl_el = null;
    window.__pet_hl_prev = null;
  }
  function pressScale(token, scale, durMs) {
    const r = ensure('', 0);
    const p = window.__pet_pos || { x: 0, y: 0 };
    const name = '__pet_press_' + token;
    r.style.textContent = '@keyframes ' + name + ' { 0% { transform: translate(' + p.x + 'px,' + p.y + 'px) scale(1) } 100% { transform: translate(' + p.x + 'px,' + p.y + 'px) scale(' + scale + ') } }';
    r.el.style.animation = 'none';
    void r.el.offsetWidth;
    r.el.style.animation = name + ' ' + durMs + 'ms ease-in-out forwards';
    function done() {
      r.el.removeEventListener('animationend', done);
      r.el.style.animation = 'none';
      r.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px) scale(' + scale + ')';
      if (typeof window['${BINDING}'] === 'function') window['${BINDING}'](token);
    }
    r.el.addEventListener('animationend', done);
  }
  window.__pet = { v: ${SCRIPT_VERSION}, ensure: ensure, animate: animate, flash: flash, snapshot: snapshot, nearby: nearby, rest: rest, stay: stay, unstay: unstay, liveCenter: liveCenter, liveSel: liveSel, dismissCookies: dismissCookies, highlight: highlight, unhighlight: unhighlight, pressScale: pressScale };
})();
`;

export interface RendererOptions {
  cursor: string;
  size: number;
  speed: number;
}

/**
 * Renderer — the pluggable visualization layer.
 *
 * v0.1 ships one impl (CursorRenderer). The interface exists so v0.3+
 * (PetRenderer with sprite-sheet, PlatformRenderer with Shimeji-style
 * physics + DOM platform collision, etc.) can drop in without touching
 * wrapper.ts or cli.ts.
 */
export interface Renderer {
  install(): Promise<void>;
  position(): Pt;
  setPosition(p: Pt): void;
  moveTo(target: Pt, opts?: { dispatchMouseEvents?: boolean; buttons?: number; duration?: number }): Promise<void>;
  flash(): Promise<void>;
  highlight(target: string | number, color?: string): Promise<void>;
  unhighlight(): Promise<void>;
  pressScale(scale: number, durMs: number): Promise<void>;
}

export class CursorRenderer implements Renderer {
  private current: Pt = { x: 0, y: 0 };
  private tokenCounter = 0;

  constructor(private client: CDPClient, private opts: RendererOptions) {}

  async install(): Promise<void> {
    await this.client.send("Runtime.addBinding", { name: BINDING });
    await this.client.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT });
    await this.client.send("Runtime.evaluate", { expression: PAGE_SCRIPT });
    const res = await this.client.send<{ result: { value: Pt | null } }>("Runtime.evaluate", {
      expression: "window.__pet_pos || null",
      returnByValue: true,
    });
    if (res.result?.value) this.current = res.result.value;
  }

  position(): Pt {
    return { ...this.current };
  }

  setPosition(p: Pt): void {
    this.current = { ...p };
  }

  async moveTo(target: Pt, opts?: { dispatchMouseEvents?: boolean; buttons?: number; duration?: number }): Promise<void> {
    const dist = Math.hypot(target.x - this.current.x, target.y - this.current.y);
    if (dist < 1) return;
    const duration = opts?.duration ?? Math.max(120, Math.min(900, (dist / this.opts.speed) * 1000));

    // Drag mode: cursor MUST stay in lockstep with the dispatched mouseMoved
    // events. CSS keyframe animation runs on the compositor at its own pace
    // and finishes ~100ms before the dispatch loop, so the dragged element
    // (which follows real mouse coords) visibly lags behind the cursor.
    // Drive both from the same loop: each iteration sets cursor inline
    // transform AND dispatches mouseMoved to the same path point.
    if (opts?.dispatchMouseEvents) {
      const path = bezierPath(this.current, target, 16);
      const stepDelay = Math.max(15, (duration - path.length * 8) / path.length);
      for (const p of path) {
        await this.client.send("Runtime.evaluate", {
          expression: `(() => { const el = document.getElementById('__pet_cursor__'); if (el) { el.style.animation = 'none'; el.style.transform = 'translate(${p.x}px,${p.y}px) scale(1)'; } window.__pet_pos = { x: ${p.x}, y: ${p.y} }; })()`,
        });
        await this.client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x,
          y: p.y,
          button: "none",
          buttons: opts.buttons ?? 0,
        });
        await sleep(stepDelay);
      }
      this.current = target;
      return;
    }

    // Cursor-only move: smooth CSS keyframe animation
    const path = bezierPath(this.current, target, 24);
    const token = `t${++this.tokenCounter}`;
    const arrived = this.waitForToken(token);
    const expr = `window.__pet && window.__pet.animate(${JSON.stringify(token)},${JSON.stringify(this.opts.cursor)},${this.opts.size},${JSON.stringify(path)},${duration})`;
    await this.client.send("Runtime.evaluate", { expression: expr });
    await arrived;
    this.current = target;
  }

  async flash(): Promise<void> {
    const token = `f${++this.tokenCounter}`;
    const arrived = this.waitForToken(token);
    const expr = `window.__pet && window.__pet.flash(${JSON.stringify(token)},${JSON.stringify(this.opts.cursor)},${this.opts.size})`;
    await this.client.send("Runtime.evaluate", { expression: expr });
    await arrived;
  }

  async highlight(target: string | number, color?: string): Promise<void> {
    const arg = typeof target === "number" ? String(target) : JSON.stringify(target);
    await this.client.send("Runtime.evaluate", {
      expression: `window.__pet && window.__pet.highlight(${arg}, ${color ? JSON.stringify(color) : "null"})`,
    });
  }

  async unhighlight(): Promise<void> {
    await this.client.send("Runtime.evaluate", { expression: "window.__pet && window.__pet.unhighlight()" });
  }

  async pressScale(scale: number, durMs: number): Promise<void> {
    const token = `p${++this.tokenCounter}`;
    const arrived = this.waitForToken(token);
    await this.client.send("Runtime.evaluate", {
      expression: `window.__pet && window.__pet.pressScale(${JSON.stringify(token)}, ${scale}, ${durMs})`,
    });
    await arrived;
  }

  private waitForToken(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.client.on("Runtime.bindingCalled", (p) => {
        if (p?.name === BINDING && p?.payload === token) {
          off();
          clearTimeout(timer);
          resolve();
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`pet-cursor: animation timeout (${token})`));
      }, 5000);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
