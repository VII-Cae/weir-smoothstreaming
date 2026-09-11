/*!
 * weir-lite.js — smooth streaming text, without the fade-in.
 * https://github.com/VII-Cae/weir-smoothstreaming · MIT © 2026 VII-Cae (VII)
 *
 * The problem it solves: a chat UI that renders LLM output token-by-token
 * usually does this on every delta:
 *
 *     el.textContent = fullTextSoFar;   // or:  el.textContent += chunk;
 *
 * which produces two independent kinds of jank:
 *
 *   1. The write rhythm is the network's rhythm. Even a token-level stream
 *      arrives in bursts — several tokens get coalesced into one WebSocket
 *      frame, and inter-frame gaps jitter. Writing straight through means you
 *      are watching the jitter, not the text.
 *
 *   2. Every delta re-lays-out text that is already final. Reassigning
 *      textContent destroys and rebuilds the text node, so the browser throws
 *      away the line-breaking it already computed for the whole message. The
 *      cost grows with message length: the second half of a long reply pays,
 *      on every single delta, for the first half that is never going to change.
 *
 * What this does instead:
 *
 *   · Deltas go into a buffer, never straight to the DOM. A rAF loop emits
 *     characters at a rate derived from the backlog, so on a 120Hz display you
 *     get 120 small even steps instead of 8 lurches. The rate adapts: fast
 *     when the model is fast, winding down when it stops, always keeping about
 *     CATCHUP seconds of buffered text as a shock absorber.
 *
 *   · Only the paragraph that is still growing is touched, via
 *     Text.appendData(). A paragraph sealed by a blank line is never written
 *     to again, so the browser keeps its layout.
 *
 *   · Scroll-follow happens at most once per frame, through the onGrow hook,
 *     instead of forcing a synchronous layout on every delta.
 *
 * No dependencies. Works as a plain <script> and under Node (for the tests).
 * MIT licensed.
 */
"use strict";

(function (root) {

  /* Emission rate = backlog / catch-up window, clamped.
   * CATCHUP doubles as the display's lag behind the network: a 0.3s pool is
   * enough to absorb frame jitter, short enough that nobody perceives a delay. */
  const CATCHUP = 0.30;        // mid-stream: drain the current backlog within 0.3s
  const CATCHUP_END = 0.09;    // after end(): wrap up faster, don't make them wait on a tail
  const MIN_CPS = 8;           // floor, so the last character or two don't asymptote forever
  const MAX_CPS = 1400;        // ceiling: a huge burst should still flow, not teleport
  const JUMP_DT = 0.35;        // a frame this long means the tab just came back — catch up, don't replay
  const WATCHDOG_MS = 250;     // rAF silent this long while "visible" = an environment that
                               // never animates; fall back to writing straight through

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* Must share a time origin with the timestamp rAF passes in, or dt is garbage. */
  const nowMs = () => (root.performance && root.performance.now
    ? root.performance.now() : Date.now());

  /* Browsers do not run rAF in a hidden tab at all (measured: one frame per two
   * seconds). There is no audience for the animation then — only a need for the
   * data to land. So while hidden we write straight through: text goes to the
   * DOM on arrival, no queue, no waiting for a frame. Without this the text
   * freezes mid-message and the end() promise stays pending, which in turn
   * blocks whatever the caller does after the stream (re-render, enabling UI). */
  const hidden = () => !!(root.document && root.document.visibilityState === "hidden");
  const liveFlows = new Set();
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener("visibilitychange", () => {
      if (hidden()) for (const f of Array.from(liveFlows)) f._catchUp();
    });
  }

  class Flow {
    /**
     * @param host             element that will hold the text
     * @param opts.block       paragraph tag name; null = no paragraphs, one text node
     * @param opts.blockClass  class for each paragraph element
     * @param opts.onGrow      called at most once per frame, after characters land
     * @param opts.doc         document (injectable for tests)
     */
    constructor(host, opts) {
      opts = opts || {};
      this.host = host;
      this.doc = opts.doc || (typeof document !== "undefined" ? document : null);
      this.block = opts.block === undefined ? "p" : opts.block;
      this.blockClass = opts.blockClass || "";
      this.onGrow = opts.onGrow || null;

      this.text = "";        // everything received so far, emitted or not
      this.shown = 0;        // how much of it has reached the DOM
      this.ended = false;    // upstream is done
      this.dead = false;     // cancelled

      this._hold = "";       // trailing newlines held back: paragraph break or not, we can't tell yet
      this._block = null;    // the paragraph currently growing
      this._tail = null;     // the text node currently being appended to
      this._credit = 0;      // sub-character remainder of the emission rate
      this._raf = 0;
      this._guard = 0;       // watchdog timer for environments that never run rAF
      this._last = 0;
      this._settled = false;
      this._resolve = null;
      this.drained = new Promise((r) => { this._resolve = r; });
      liveFlows.add(this);
    }

    /** Feed one delta. Buffers only — unless nobody is looking at the page. */
    push(t) {
      if (this.dead || this.ended || !t) return;
      this.text += t;
      if (hidden()) this._catchUp();
      else this._kick();
    }

    /** Upstream finished. The returned promise resolves once the DOM is complete,
     *  so do any "re-render the finished message" work after awaiting it —
     *  otherwise the still-buffered tail is dumped out all at once. */
    end() {
      if (!this.dead && !this.ended) {
        this.ended = true;
        if (hidden()) this._catchUp();
        if (this.shown >= this.text.length) this._settle();
        else this._kick();
      }
      return this.drained;
    }

    /** Land everything received so far immediately, but do NOT close the stream.
     *  That is the whole difference from flush(): flush means "this is the end",
     *  catchUp means "stop animating, keep receiving". Using flush() while hidden
     *  would set `ended` and silently drop every delta that arrives afterwards. */
    _catchUp() {
      if (this.dead || this._settled) return;
      this._clearGuard();
      if (this._raf && root.cancelAnimationFrame) root.cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._credit = 0;
      if (this.shown < this.text.length) {
        this._write(this.text.slice(this.shown));
        this.shown = this.text.length;
        if (this.onGrow) this.onGrow();
      }
    }

    /** Stop animating and write the remainder now (switching views, tearing down). */
    flush() {
      if (this.dead) return;
      if (this.shown < this.text.length) {
        this._write(this.text.slice(this.shown));
        this.shown = this.text.length;
      }
      this.ended = true;
      this._settle();
    }

    /** Drop the remainder and stop. Whatever already landed stays as it is. */
    cancel() {
      this.dead = true;
      this._settle();
    }

    // ---- internals ----

    /* Restart the clock. The subtle part is recording `_last` as *now* rather
     * than zeroing it. A zero sentinel makes the next frame bill a hardcoded
     * 1/60s, so the effective emission rate becomes
     *     actual frame rate ÷ 60 × target rate.
     * At a solid 60fps that is exactly right and hides the bug completely; drop
     * to 10fps (background tab, busy machine, a webview that isn't compositing)
     * and the text crawls at a sixth of the intended speed — and dt can never
     * reach JUMP_DT, so even the catch-up path never fires. Measured in an
     * environment throttled to roughly 1fps: five characters in five seconds.
     * performance.now() shares rAF's time origin, so billing stays honest at
     * any frame rate. */
    _kick() {
      if (this._raf || this.dead || this._settled) return;
      this._last = nowMs();
      this._credit = 0;    // a pause shouldn't accrue rate credit
      this._schedule();
      /* Some environments report visibilityState "visible" yet never run rAF —
       * webviews that aren't compositing, some embedded panels. Without a guard
       * the text would simply never appear, which is far worse than not pacing
       * it. If the first frame doesn't arrive, write straight through instead. */
      if (!this._guard && root.setTimeout) {
        this._guard = root.setTimeout(() => { this._guard = 0; this._catchUp(); }, WATCHDOG_MS);
      }
    }

    _clearGuard() {
      if (this._guard && root.clearTimeout) root.clearTimeout(this._guard);
      this._guard = 0;
    }

    _schedule() {
      const raf = root.requestAnimationFrame || ((f) => setTimeout(() => f(Date.now()), 16));
      this._raf = raf((ts) => this._frame(ts));
    }

    _frame(ts) {
      this._raf = 0;
      this._clearGuard();      // a frame arrived: this environment animates fine
      if (this.dead || this._settled) return;

      const dt = Math.max(0, ts - this._last) / 1000;
      this._last = ts;
      const pend = this.text.length - this.shown;

      let n;
      if (dt > JUMP_DT) {
        n = pend;                     // just back from the background: catch up, don't replay
        this._credit = 0;
      } else {
        const cps = clamp(pend / (this.ended ? CATCHUP_END : CATCHUP), MIN_CPS, MAX_CPS);
        this._credit += cps * dt;
        n = Math.min(Math.floor(this._credit), pend);
        this._credit -= n;
      }

      if (n > 0) {
        this._write(this.text.substr(this.shown, n));
        this.shown += n;
        if (this.onGrow) this.onGrow();
      }

      if (this.shown < this.text.length) { this._schedule(); return; }
      if (this.ended) this._settle();
      else this._credit = 0;   // pool is empty: stop the loop, next push restarts it
    }

    /** Land a slice of text. Blank lines split paragraphs; single newlines stay
     *  inside the paragraph for CSS (white-space) to deal with. */
    _write(s) {
      let t = this._hold + s;
      this._hold = "";
      if (!this.block) {
        if (t) this._emit(t);
        return;
      }
      // Hold back trailing newlines — only the next slice reveals whether they
      // were a paragraph break or just a line break inside one.
      const m = /\n+$/.exec(t);
      if (m) { this._hold = m[0]; t = t.slice(0, t.length - m[0].length); }
      const parts = t.split(/\n{2,}/);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) { this._block = null; this._tail = null; }   // sealed: never touched again
        if (parts[i]) this._emit(parts[i]);
      }
    }

    /** Append to the text node that is still growing. Zero new nodes — this is
     *  the cheapest write the DOM offers, and the whole point of the exercise. */
    _emit(s) {
      const box = this._blockNode();
      if (!this._tail) {
        this._tail = this.doc.createTextNode("");
        box.appendChild(this._tail);
      }
      this._tail.appendData(s);
    }

    _blockNode() {
      if (!this.block) return this.host;
      if (!this._block) {
        const el = this.doc.createElement(this.block);
        if (this.blockClass) el.className = this.blockClass;
        this.host.appendChild(el);
        this._block = el;
        this._tail = null;
      }
      return this._block;
    }

    _settle() {
      if (this._settled) return;
      this._settled = true;
      this._clearGuard();
      if (this._raf && root.cancelAnimationFrame) root.cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._hold = "";          // trailing blank lines shouldn't leave an empty paragraph
      liveFlows.delete(this);
      const r = this._resolve;
      this._resolve = null;
      if (r) r();
    }
  }

  /** Drive a Flow from an async iterable; resolves once the DOM is complete.
   *  opts.firstChunkTimeout: reject with Error('silence') if nothing arrives in time.
   *  On upstream errors the text already received is allowed to finish emitting
   *  first, so an error notice never cuts in ahead of half a sentence. */
  async function pipe(host, iter, opts) {
    opts = opts || {};
    const flow = new Flow(host, opts);
    const it = iter[Symbol.asyncIterator] ? iter[Symbol.asyncIterator]() : iter;
    try {
      let step;
      if (opts.firstChunkTimeout) {
        let timer;
        try {
          step = await Promise.race([
            it.next(),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("silence")), opts.firstChunkTimeout); }),
          ]);
        } finally { clearTimeout(timer); }
      } else {
        step = await it.next();
      }
      while (!step.done) {
        flow.push(step.value);
        step = await it.next();
      }
    } catch (err) {
      await flow.end();
      throw err;
    }
    await flow.end();
    return flow;
  }

  const api = { Flow, pipe, open: (host, opts) => new Flow(host, opts) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Weir = api;

})(typeof window !== "undefined" ? window : globalThis);
