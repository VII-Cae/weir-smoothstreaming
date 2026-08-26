# weir

Smooth streaming text for LLM chat UIs. ~215 lines of code, no dependencies, MIT.

[中文版 →](README.zh.md)

Two things, both of which you probably want:

1. **Pacing.** Deltas go into a buffer; a `requestAnimationFrame` loop emits characters at a rate derived from the backlog. On a 120Hz display that is 120 small even steps per second instead of eight lurches.
2. **Append-only writes.** Only the paragraph that is still growing is ever touched. Once a paragraph is sealed by a blank line, it is never written to again.

Optionally, a third: **per-character fade-in**, where each frame's new characters surface rather than snap into place.

```
git clone <this repo> && cd weir
npm test                 # 63 assertions, plain node, no dev dependencies
open demo/index.html     # A/B against the naive version (or serve the folder, if your browser blocks file://)
```

The demo runs three panes on the same delta stream — naive, `weir-lite`, `weir` with fade — one at a time, with frame-rate numbers for each. Run it in a **visible tab**; see [Two bugs you will hit](#two-bugs-you-will-hit) for why.

---

## The problem

The usual way to render a token stream is one of these:

```js
socket.onmessage = (e) => {
  full += JSON.parse(e.data).text;
  el.textContent = full;            // A
  // or
  el.textContent += chunk;          // B
  el.scrollTop = el.scrollHeight;
};
```

Both feel fine on a two-sentence answer and get visibly worse the longer the reply runs. There are three separate causes, and they are easy to mistake for one.

### 1. The write rhythm is the network's rhythm

Even a token-level stream does not arrive evenly. Several tokens get coalesced into one WebSocket frame or one SSE flush; the event loop batches them further; the gaps between arrivals jitter by tens of milliseconds. Writing each delta straight to the DOM means the text moves exactly as the network delivered it — so what you are watching is the jitter, not the text.

This one is invisible in a profiler. The frame rate can be a perfect 120fps while the text still looks like it is stuttering, because the stutter is in *when* characters appear, not in how long the browser took to paint them.

### 2. Every write pays for text that is already final

`el.textContent = full` destroys the existing text node and builds a new one. The browser throws away the line breaking, glyph positioning, and line boxes it had already computed for the entire message, then redoes all of it.

`el.textContent += chunk` reads no better: it is a read of the whole string, a concatenation, and an assignment — same teardown, same rebuild.

The cost scales with what is already on screen, so it is worst exactly where you least want it. Halfway through a long answer, every single delta is paying to re-lay-out the half that will never change again.

### 3. Every delta forces a synchronous layout

```js
const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;  // read
el.textContent = full;                                                   // write
if (atBottom) el.scrollTop = el.scrollHeight;                            // read + write
```

Reading `scrollHeight` after a write forces the browser to finish layout right there, before it can answer. Interleaved read-write-read, dozens of times a second, is textbook layout thrashing.

---

## The fix

### Step 1 — take the rhythm back from the network

Deltas go into a buffer. A rAF loop decides how many characters to emit this frame:

```js
const CATCHUP = 0.30;      // mid-stream: drain the current backlog within 0.3s
const CATCHUP_END = 0.09;  // after end(): wrap up faster
const MIN_CPS = 8;
const MAX_CPS = 1400;

const backlog = text.length - shown;
const cps = clamp(backlog / (ended ? CATCHUP_END : CATCHUP), MIN_CPS, MAX_CPS);
credit += cps * dt;                       // dt = seconds since the last frame
const n = Math.min(Math.floor(credit), backlog);
credit -= n;
```

The rate is proportional to the backlog, which gives the behaviour you want for free: fast when the model is fast, winding down as it finishes, and steady in between. `credit` carries the sub-character remainder so slow streams still advance rather than rounding to zero every frame.

`CATCHUP` is the one number worth thinking about. It is not just a smoothing constant — it *is* how far the display is allowed to lag behind the network. At 0.3s there is always about a third of a second of buffered text acting as a shock absorber, which is enough to swallow a whole frame of network jitter and short enough that nobody perceives a delay. Lower it and jitter starts coming through; raise it and the text feels a beat late.

The loop stops when the buffer empties and restarts on the next `push`, so an idle stream costs nothing.

### Step 2 — only touch what is still changing

Keep a reference to the text node currently being appended to, and append to it:

```js
tail.appendData(slice);     // no teardown, no rebuild
```

`CharacterData.appendData` is the increment the DOM actually offers. The browser knows text was only added at the end and can reuse most of what it already computed.

Then split on blank lines. When a paragraph ends, drop the reference:

```js
if (blankLineHere) { block = null; tail = null; }   // sealed — never written to again
```

The next write creates a fresh `<p>` and a fresh text node. Everything above it is now inert: no writes, no invalidation, layout preserved for the rest of the stream.

There is one wrinkle. Emission is character-by-character, so a `\n\n` can be split across two frames — you might emit `…text\n` and only learn on the next frame whether the following character is another newline (paragraph break) or a letter (line break inside the paragraph). So trailing newlines are held back one frame:

```js
const m = /\n+$/.exec(t);
if (m) { hold = m[0]; t = t.slice(0, -m[0].length); }   // decide next frame
```

Miss this and you get paragraph breaks that appear or vanish depending on where the network happened to slice — a bug that reproduces maybe one time in twenty.

### Step 3 — scroll at most once per frame

Move the "are we at the bottom" test into a `scroll` listener, where reading geometry is free because nothing is pending:

```js
let stick = true;
el.addEventListener("scroll", () => {
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}, { passive: true });

// in the flow's onGrow, at most once per frame:
if (stick) el.scrollTop = el.scrollHeight;
```

Dozens of forced layouts per second become one per frame, at most.

### Step 4 (optional) — the fade

Each frame's new characters go into their own span:

```js
const w = doc.createElement("span");
w.className = "weir-wet";
w.appendChild(doc.createTextNode(slice));
block.appendChild(w);
```

```css
@keyframes weir-wet { from { opacity: 0 } to { opacity: 1 } }
.weir-wet { animation: weir-wet 300ms ease-out both; }

@media (prefers-reduced-motion: reduce) { .weir-wet { animation: none; } }
```

One span per frame, **not per character**. At a high refresh rate a frame carries two or three characters, which the eye reads as continuous surfacing anyway — and a span per character would mean thousands of nodes and thousands of concurrent animations for no visible gain.

Four details that matter:

- **Only `opacity`.** Translating the span changes its layout box, and the whole line jitters as it reflows.
- **`both`** as the fill mode. Without it there is one frame where the span is painted at full opacity before the animation starts — a visible flash on every frame.
- **Appending a span still does not touch sealed paragraphs.** The performance work above survives; the only change is one appended node per frame instead of one `appendData`.
- **Flatten when the stream ends.** Once everything has arrived, replace each paragraph's contents with plain text:

  ```js
  for (const b of blocks) b.textContent = b.textContent;
  ```

  This costs one paragraph-level reflow, at a moment when nobody is watching. It matters if you ever cache the finished `innerHTML` and re-insert it later (restoring a view, reopening a panel): markup that still carries the animation class **replays the entire animation at once**, which reads as a twitch. It also returns the DOM to one text node per paragraph.

Catch-up frames skip the fade deliberately — several hundred characters lighting up together is a flash, not a fade.

---

## Two builds

| | `src/weir-lite.js` | `src/weir.js` |
|---|---|---|
| rAF pacing | ✔ | ✔ |
| append-only writes | ✔ | ✔ |
| paragraph sealing | ✔ | ✔ |
| hidden-tab handling | ✔ | ✔ |
| per-character fade-in | — | ✔ (`fade: true`) |
| lines of code (excl. comments) | ~190 | ~215 |

Both are standalone — take one file, not both. `lite` is there because the fade is genuinely optional and the shorter file is easier to read if you are going to adapt it rather than use it as-is. The pacing and the DOM work, which is where all the performance comes from, are identical.

Both expose the same global (`window.Weir`) and the same CommonJS export, so they are drop-in replacements for each other.

---

## Using it

```html
<script src="src/weir.js"></script>
```

```js
const flow = Weir.open(container, {
  block: "p",            // paragraph tag; null = one text node, no paragraphs
  blockClass: "msg-p",   // class on each paragraph
  fade: true,            // full build only
  onGrow: () => { if (stick) container.scrollTop = container.scrollHeight; },
});

socket.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "delta") flow.push(m.text);
  if (m.type === "done") {
    flow.end().then(() => {
      // The DOM is complete only now. Do the "finished message" work here —
      // markdown rendering, syntax highlighting, timestamps, action buttons.
    });
  }
};
```

**`end()` returns a promise, and you have to await it.** `done` usually arrives while dozens of characters are still buffered; re-rendering immediately dumps them all out at once and undoes the pacing. This is the single easiest thing to get wrong when wiring it up.

If your source is an async iterable, `pipe` does the whole loop:

```js
await Weir.pipe(container, streamOfChunks, {
  block: "p",
  fade: true,
  firstChunkTimeout: 30000,   // rejects with Error("silence")
});
// resolves once the DOM is complete
```

On an upstream error, `pipe` lets the text it already received finish emitting before rethrowing, so an error notice never cuts in ahead of half a sentence.

### API

| | |
|---|---|
| `Weir.open(host, opts)` | create a flow |
| `Weir.pipe(host, asyncIterable, opts)` | create one and drive it to completion |
| `flow.push(text)` | feed a delta |
| `flow.end()` | → `Promise`, resolves when the DOM is complete |
| `flow.flush()` | write the remainder now and close (tearing down, switching views) |
| `flow.cancel()` | drop the remainder and stop; resolves `drained` so nothing hangs |
| `flow.text` | everything received so far, emitted or not |
| `flow.shown` | how much has reached the DOM |
| `flow.drained` | the same promise `end()` returns |

Options: `block` (default `"p"`), `blockClass`, `onGrow`, `fade`, `fadeClass` (default `"weir-wet"`), `firstChunkTimeout` (pipe only), `doc`.

`flush()` and `cancel()` are not interchangeable. `flush` means *this is the end* — it closes the stream, and any delta arriving afterwards is dropped. Use it when you are done with the flow. `cancel` means *throw the rest away*, for when the container is about to be removed anyway.

---

## Three things that will bite you

All three were found by running this in a real browser, not by reasoning about it. All three share a shape: `requestAnimationFrame` is less dependable than it looks, and every failure is invisible on a healthy 60fps desktop tab.

### 1. Emission speed silently tracks frame rate instead of time

When the buffer empties, the rAF loop stops; the next `push` restarts it. The obvious way to restart is to clear the timestamp and let the next frame treat itself as the first:

```js
last = 0;
// ...in the frame:
const dt = last ? (ts - last) / 1000 : 1 / 60;   // ← wrong
```

At a solid 60fps that fallback is exactly right, which is precisely why the bug hides. But a slow stream empties the buffer between almost every delta, so *most* frames take that branch — and each one bills a hardcoded 1/60s no matter how long really passed. The effective rate becomes:

```
actual frame rate ÷ 60 × target rate
```

At 10fps the text crawls at a sixth of the intended speed. Worse, `dt` can never exceed the catch-up threshold, so the "we were in the background, just catch up" path never fires either. Measured in a webview throttled to roughly 1fps: **five characters in five seconds**.

The fix is to record a real timestamp on restart, from the same clock rAF uses:

```js
last = performance.now();          // shares rAF's time origin
// ...in the frame:
const dt = Math.max(0, ts - last) / 1000;
```

Regression test: at 1fps, six seconds must still emit everything.

### 2. A hidden tab freezes the stream — and leaves `end()` pending

Browsers do not throttle `requestAnimationFrame` in a background tab; they stop it. Measured: one frame per two seconds, and that only because a screenshot forced a composite.

For the text itself that is arguably fine — nobody is looking. The real damage is downstream: `end()` never resolves, so everything you scheduled after it never runs. The message stays half-rendered, whatever you do on completion (re-render, re-enable the composer, attach action buttons) never happens, and it all stays stuck until the user comes back.

So while hidden, skip the animation and write straight through:

```js
const hidden = () => document.visibilityState === "hidden";

push(t) {
  this.text += t;
  if (hidden()) this._catchUp();    // land immediately
  else this._kick();                // normal paced path
}
```

with a `visibilitychange` listener catching flows that were mid-animation when the tab went away.

The trap inside the trap: `_catchUp` is **not** `flush`. `flush` closes the stream, so using it here would silently drop every delta that arrives while the tab is in the background — which is most of them. It has to be "land everything now, but stay open".

---

### 3. "Visible" does not guarantee rAF runs at all

The two fixes above both assume frames eventually arrive. Some environments break that assumption outright: an embedded webview that isn't compositing can report `visibilityState: "visible"` and still never invoke a single rAF callback. Measured in one such panel: the naive version rendered fine and weir emitted **nothing at all** — strictly worse than doing nothing clever.

So the visibility check is not enough on its own. Arm a timer when the loop starts, and if the first frame never comes, degrade to writing straight through:

```js
this._schedule();
if (!this._guard) {
  this._guard = setTimeout(() => { this._guard = 0; this._catchUp(); }, 250);
}
// ...and in the frame callback:
this._clearGuard();     // a frame arrived: this environment animates fine
```

One timer per restart, cleared by the first frame that shows up. In a normal browser it never fires. Where it does fire, the text degrades to arriving in 250ms batches instead of never arriving — which is the whole point of a fallback.

## Tuning

At the top of either source file:

| | default | |
|---|---|---|
| `CATCHUP` | `0.30` | how far the display may lag, in seconds. Lower = more responsive, more jitter |
| `CATCHUP_END` | `0.09` | catch-up window after `end()`; keeps the tail from dragging |
| `MIN_CPS` | `8` | floor, so the last character or two don't asymptote |
| `MAX_CPS` | `1400` | ceiling; a huge burst should still flow rather than teleport |
| `JUMP_DT` | `0.35` | a frame longer than this means catch up, don't replay |
| `FADE_MAX` | `48` | past this many characters in one frame, skip the fade |

Fade duration is in your CSS (`@keyframes weir-wet`), not in the JS. 300ms is a reasonable default; below ~150ms it stops reading as a fade, above ~500ms the text feels like it is arriving through fog.

If you are rendering CJK, note that `CATCHUP` is in seconds and the rate is in characters — the same settings give a slower-feeling stream for a language that packs more meaning per character. Somewhere around `0.22` is a better starting point there.

---

## Tests

```
npm test          # or: node test/weir.test.js
```

63 assertions against **both** builds, using a fake DOM and a hand-cranked rAF clock — plain node, no browser, no dependencies. They guard the things that break invisibly:

- not one character is lost, including across 60 different delta slicings of the same text, and when a `\n\n` straddles two chunks
- a sealed paragraph never takes another write
- a burst is spread over several frames instead of dumped
- emission tracks wall-clock time, not frame rate (regression for #1)
- a hidden tab writes straight through and `end()` resolves immediately (regression for #2)
- text still lands when rAF never fires at all (regression for #3)
- fading flattens back to one text node per paragraph, with no spans left behind

The hand-cranked clock is what makes this testable at all: `step(1000)` simulates a 1fps environment exactly, deterministically, in about a microsecond.

---

## The name

A weir is a low dam laid across a river. Its whole purpose is to turn uneven, surging flow into a steady overflow — a *measuring* weir exists precisely to convert irregular water into a readable, constant rate. That is the same physics as `CATCHUP`: hold a little back, and the pulsing upstream of it stops showing downstream.

Two things follow from the shape of the thing.

A weir only works by keeping the water above it higher than the water below. **It has to lag in order to be steady** — which is exactly what those 300 milliseconds buy.

And a weir is not a dam. A dam's job is to hold water back; a weir's job is to let it keep going, just evenly. That distinction is precisely the difference between this and buffering the whole response to show it at the end.

## License

MIT.
