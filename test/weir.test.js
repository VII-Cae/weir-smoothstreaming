/*
 * Invariants for weir (node test/weir.test.js).
 *
 * The shared suite runs against BOTH builds — weir-lite.js and weir.js —
 * because the fade-in must not change any of the guarantees below. It guards:
 *
 *  1. Not one character may be lost. Smoothing the rhythm means the display
 *     lags the network, so any mistake in the newline hold-back or the
 *     paragraph sealing drops text somewhere nobody would ever notice by eye.
 *
 *  2. A sealed paragraph is never touched again. That is the entire point of
 *     the exercise: if some change lets old paragraphs take writes again, the
 *     performance win silently reverts while everything still looks fine.
 *
 *  3. A burst must be spread over several frames, or we are back to lurching.
 *
 *  4. Emission speed tracks wall-clock time, not frame rate.
 *
 *  5. A hidden tab writes straight through and never leaves end() pending.
 *
 * Uses a fake document and a hand-cranked rAF clock, so it runs under plain
 * node with no browser and no dependencies.
 */
"use strict";
const path = require("path");

// ---- fake DOM: only the four calls weir makes, plus bookkeeping ----
let writeLog = [];          // [{node, frame}]
let frameNo = 0;

class FText {
  constructor() { this.data = ""; this.id = FText.n++; }
  appendData(s) { this.data += s; writeLog.push({ node: this.id, frame: frameNo }); }
}
FText.n = 0;

class FEl {
  constructor(tag) { this.tagName = tag; this.className = ""; this.childNodes = []; }
  appendChild(n) { this.childNodes.push(n); return n; }
  get textContent() {
    return this.childNodes.map((c) => (c instanceof FText ? c.data : c.textContent)).join("");
  }
  /* Flattening: replace the whole block with a single text node. Deliberately
     not routed through appendData, so it does not count as "writing to a
     paragraph that is still growing". */
  set textContent(v) { const t = new FText(); t.data = v; this.childNodes = [t]; }
  get blocks() { return this.childNodes.filter((c) => c instanceof FEl); }
  get spans() { return this.childNodes.filter((c) => c instanceof FEl && c.className); }
}

const doc = {
  createElement: (t) => new FEl(t),
  createTextNode: () => new FText(),
};

// ---- hand-cranked rAF ----
let queue = [];
let clock = 0;
global.window = {
  requestAnimationFrame: (f) => { queue.push(f); return queue.length; },
  cancelAnimationFrame: () => {},
  /* Same time origin as the hand-cranked clock — weir uses it to re-sync
     whenever the buffer ran dry and the loop stopped. */
  performance: { now: () => clock },
  /* Visibility: while hidden, weir writes straight through instead of
     queueing, because browsers do not run rAF in background tabs. */
  document: { visibilityState: "visible", addEventListener: () => {} },
  /* Real timers, for the watchdog that covers environments which claim to be
     visible but never actually run rAF. */
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};
const setHidden = (on) => { global.window.document.visibilityState = on ? "hidden" : "visible"; };

/** advance one frame by dt milliseconds */
function step(dt = 8) {
  const q = queue;
  queue = [];
  clock += dt;
  frameNo++;
  for (const f of q) f(clock);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("    ok   " + name); }
  else { fail++; console.log("    FAIL " + name + (detail ? "  — " + detail : "")); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        "got " + JSON.stringify(got) + " want " + JSON.stringify(want));

/* ================================================================== */

function makeHarness(Weir) {
  function open(opts) {
    writeLog = [];
    frameNo = 0;
    clock = 0;
    queue = [];
    const host = new FEl("div");
    return { host, flow: Weir.open(host, Object.assign({ doc }, opts)) };
  }
  /** drain the flow, cranking frames while awaiting */
  async function settle(flow, dt = 8, max = 4000) {
    const p = flow.end();
    let done = false;
    p.then(() => { done = true; });
    for (let i = 0; i < max && !done; i++) { step(dt); await null; }
    // Force-close if the pump stalls: otherwise `await p` hangs forever, node
    // exits silently, and it looks like the rest of the file was never written.
    if (!done) { console.log("    !    settle timed out, forcing flush"); flow.flush(); await null; }
    await p;
    return done;
  }
  return { open, settle };
}

/** The guarantees both builds must provide. */
async function sharedSuite(Weir, label) {
  const { open, settle } = makeHarness(Weir);
  console.log("\n" + label);

  console.log("  1. not one character may be lost");

  {
    const { host, flow } = open();
    flow.push("First paragraph.");
    flow.push(" Still the first.\n\nSecond starts");
    flow.push(" and finishes.");
    await settle(flow);
    eq("blank line splits paragraphs", host.blocks.map((b) => b.textContent),
       ["First paragraph. Still the first.", "Second starts and finishes."]);
  }

  {
    // The paragraph break straddles two chunks. This is what the hold-back is
    // for: emission is character-by-character, so the split points are finer
    // than chunk boundaries and a mistake here only shows up intermittently.
    const { host, flow } = open();
    flow.push("end of one\n");
    flow.push("\nstart of the next");
    await settle(flow);
    eq("\\n\\n split across chunks still splits", host.blocks.map((b) => b.textContent),
       ["end of one", "start of the next"]);
  }

  {
    const { host, flow } = open();
    flow.push("a single newline\nstays inside");
    await settle(flow);
    eq("single newline stays in the paragraph",
       host.blocks.map((b) => b.textContent), ["a single newline\nstays inside"]);
  }

  {
    const { host, flow } = open();
    flow.push("that is all.\n\n\n\n");
    await settle(flow);
    eq("trailing blank lines leave no empty paragraph",
       host.blocks.map((b) => b.textContent), ["that is all."]);
  }

  {
    // Fuzz: however the deltas are sliced, the text must reassemble exactly
    const src = "Opening line.\n\nA middle paragraph with a\nline break in it.\n\nThe end.";
    let bad = null;
    for (let seed = 1; seed <= 60 && !bad; seed++) {
      const { host, flow } = open();
      let i = 0;
      while (i < src.length) {
        const n = 1 + ((seed * 7 + i * 13) % 5);      // 1-5 chars per slice, varying by seed
        flow.push(src.slice(i, i + n));
        i += n;
      }
      await settle(flow);
      const got = host.blocks.map((b) => b.textContent).join("\n\n");
      if (got !== src) bad = { seed, got };
    }
    check("text is conserved across 60 slicings", !bad,
          bad ? "seed " + bad.seed + " -> " + JSON.stringify(bad.got) : "");
  }

  console.log("  2. a sealed paragraph is never touched again");

  {
    const { host, flow } = open();
    flow.push("The first paragraph, long enough to span several frames.");
    flow.push("\n\n");
    flow.push("The second one, also long enough that frames pass between them.");
    await settle(flow);

    // Track by paragraph size rather than by node identity, so this works for
    // both builds (the fade build adds a span per frame).
    check("both paragraphs materialised", host.blocks.length === 2);
    const first = host.blocks[0].textContent;
    check("first paragraph is intact and final",
          first === "The first paragraph, long enough to span several frames.",
          JSON.stringify(first));
  }

  {
    // Node-level version of the same claim, for the lite build's append path
    const { host, flow } = open();
    flow.push("Paragraph one, long enough to take a few frames.");
    flow.push("\n\nParagraph two, also long enough to take a few frames.");
    let sealedAtFrame = -1, sizeAtSeal = 0, grewAfterSeal = false;
    for (let i = 0; i < 600 && host.blocks.length < 2; i++) step(8);
    sealedAtFrame = frameNo;
    sizeAtSeal = host.blocks[0].childNodes.length;
    for (let i = 0; i < 600 && host.blocks[1].textContent.length < 20; i++) {
      step(8);
      if (host.blocks[0].childNodes.length !== sizeAtSeal) grewAfterSeal = true;
    }
    check("no node is added to paragraph 1 after paragraph 2 begins", !grewAfterSeal,
          "sealed at frame " + sealedAtFrame);
    const writesAfter = writeLog.filter(
      (w) => w.frame > sealedAtFrame &&
             host.blocks[0].childNodes.some((c) => c instanceof FText && c.id === w.node ||
               (c.childNodes || []).some((g) => g instanceof FText && g.id === w.node)));
    check("no appendData lands in paragraph 1 after it is sealed", writesAfter.length === 0,
          writesAfter.length + " late writes");
    await settle(flow);
  }

  console.log("  3. a burst is spread over several frames");

  {
    const { host, flow } = open();
    const long = "x".repeat(400);
    flow.push(long);                       // 400 characters arrive at once
    step(8);
    const firstFrame = host.blocks.length ? host.blocks[0].textContent.length : 0;
    check("the first frame does not dump all 400", firstFrame < 120,
          firstFrame + " chars in frame 1");
    let frames = 1;
    while (host.blocks[0].textContent.length < 400 && frames < 500) { step(8); frames++; }
    check("spread across multiple frames", frames >= 4, frames + " frames");
    check("and nothing is lost", host.blocks[0].textContent === long);
    await settle(flow);
  }

  {
    // Tab was in the background: one very long frame catches up, does not replay
    const { host, flow } = open();
    const line = "Coming back to the tab should show everything at once.";
    flow.push(line);
    step(8);
    step(2000);
    check("a long gap catches up in one frame", host.blocks[0].textContent === line,
          JSON.stringify(host.blocks[0] && host.blocks[0].textContent));
    await settle(flow);
  }

  console.log("  4. speed tracks wall-clock time, not frame rate");

  {
    /* Regression for a measured failure: an embedded browser view throttled rAF
       to about 1fps and five seconds produced five characters. The cause was
       zeroing the clock on restart, which billed a hardcoded 1/60s per frame —
       so the rate became (actual fps / 60) x target, and dt could never reach
       the catch-up threshold either. */
    const { host, flow } = open();
    const CHUNK = "a short run of text. ";
    const total = 12 * CHUNK.length;
    for (let i = 0; i < 12; i++) flow.push(CHUNK);
    for (let i = 0; i < 6; i++) step(1000);            // 1fps, six frames
    check("at 1fps, six seconds still emits all " + total + " chars",
          host.blocks[0].textContent.length === total,
          "only " + host.blocks[0].textContent.length);
    await settle(flow);
  }

  {
    // Same input, same elapsed time: frame rate should change granularity only
    const fast = open();
    fast.flow.push("x".repeat(600));
    for (let i = 0; i < 60; i++) step(8);          // 125fps for 480ms
    const fastLen = fast.host.blocks[0].textContent.length;
    await settle(fast.flow);

    // one flow at a time: open() clears the global frame queue
    const slow = open();
    slow.flow.push("x".repeat(600));
    for (let i = 0; i < 6; i++) step(80);          // 12.5fps for the same 480ms
    const slowLen = slow.host.blocks[0].textContent.length;
    await settle(slow.flow);

    check("over 480ms, fast and slow frame rates emit comparable amounts",
          Math.abs(fastLen - slowLen) <= 24, fastLen + " vs " + slowLen);
  }

  console.log("  5. a hidden tab writes straight through");

  {
    setHidden(true);
    const { host, flow } = open();
    flow.push("They switched to another tab.");
    check("hidden: text lands without waiting for a frame", host.blocks.length === 1);
    flow.push(" This arrived after they left.");
    let settled = false;
    flow.drained.then(() => { settled = true; });
    flow.end();
    await null;
    check("hidden: end() resolves immediately", settled);
    eq("hidden: nothing was lost", host.blocks.map((b) => b.textContent),
       ["They switched to another tab. This arrived after they left."]);
    setHidden(false);
  }

  {
    /* Regression for a measured environment: an embedded view reported
       visibilityState "visible" but never ran a single rAF callback, so not one
       character ever reached the DOM — strictly worse than doing nothing clever
       at all. The watchdog degrades to writing straight through. Here we simply
       never crank the clock, which is exactly that environment. */
    const { host, flow } = open();
    flow.push("no frames will ever arrive here");
    await new Promise((r) => setTimeout(r, 340));    // real time, past the watchdog
    check("text still lands when rAF never fires",
          host.blocks.length === 1 &&
          host.blocks[0].textContent === "no frames will ever arrive here",
          JSON.stringify(host.blocks.map((b) => b.textContent)));
    await settle(flow);
  }

  console.log("  6. the three ways to close");

  {
    const { host, flow } = open();
    flow.push("Need the complete DOM right now.");
    flow.flush();
    eq("flush writes the remainder at once",
       host.blocks.map((b) => b.textContent), ["Need the complete DOM right now."]);
    let ok = false;
    flow.drained.then(() => { ok = true; });
    await null;
    check("flush resolves drained", ok);
  }

  {
    const { host, flow } = open();
    flow.push("this gets dropped");
    let ok = false;
    flow.drained.then(() => { ok = true; });
    flow.cancel();
    await null;
    check("cancel resolves too (never leave an await hanging)", ok);
    flow.push("and nothing after cancel lands");
    step(8);
    check("cancel stops writing", host.blocks.length === 0 || host.blocks[0].textContent === "");
  }

  {
    const { host, flow } = open({ block: null });
    flow.push("one\n\ntwo, blank line preserved verbatim");
    await settle(flow);
    eq("block:null keeps newlines verbatim", host.textContent,
       "one\n\ntwo, blank line preserved verbatim");
    check("block:null uses a single text node", host.childNodes.length === 1);
  }

  console.log("  7. pipe(): first-chunk timeout, and text received before an error");

  {
    const host = new FEl("div");
    writeLog = []; queue = []; clock = 0; frameNo = 0;
    async function* src() {
      yield "he got halfway";
      throw new Error("ws closed");
    }
    let caught = null;
    const p = Weir.pipe(host, src(), { doc, block: "p" }).catch((e) => { caught = e; });
    for (let i = 0; i < 400 && !caught; i++) { step(8); await null; }
    await p;
    check("text received before the error still finishes emitting",
          host.blocks.length === 1 && host.blocks[0].textContent === "he got halfway",
          JSON.stringify(host.blocks.map((b) => b.textContent)));
    check("the error still propagates", caught && caught.message === "ws closed");
  }

  {
    const host = new FEl("div");
    queue = [];
    async function* silent() { await new Promise(() => {}); yield ""; }
    let caught = null;
    const p = Weir.pipe(host, silent(), { doc, block: "p", firstChunkTimeout: 20 })
      .catch((e) => { caught = e; });
    await new Promise((r) => setTimeout(r, 60));
    step(8); await null;
    await p;
    check("firstChunkTimeout rejects with 'silence'", caught && caught.message === "silence",
          caught ? caught.message : "did not reject");
  }
}

/** Only the full build has these. */
async function fadeSuite(Weir, label) {
  const { open, settle } = makeHarness(Weir);
  console.log("\n" + label);
  console.log("  8. per-character fade-in");

  {
    const { host, flow } = open({ fade: true, fadeClass: "weir-wet" });
    flow.push("Paragraph one, long enough to span several frames.");
    flow.push("\n\n");
    flow.push("Paragraph two, also long enough to span several frames.");

    let sealedAt = -1, grewAfterSeal = false, sizeAtSeal = 0;
    for (let i = 0; i < 500 && (host.blocks.length < 2 || host.blocks[1].textContent.length < 15); i++) {
      step(8);
      if (host.blocks.length >= 2 && sealedAt < 0) { sealedAt = i; sizeAtSeal = host.blocks[0].childNodes.length; }
      else if (sealedAt >= 0 && host.blocks[0].childNodes.length !== sizeAtSeal) grewAfterSeal = true;
    }
    check("paragraph 1 gains no node once paragraph 2 begins", sealedAt >= 0 && !grewAfterSeal);
    check("fading starts a new span per frame (not one long-lived node)", sizeAtSeal > 2,
          sizeAtSeal + " nodes at seal");

    await settle(flow);
    eq("text is conserved after flattening", host.blocks.map((b) => b.textContent),
       ["Paragraph one, long enough to span several frames.",
        "Paragraph two, also long enough to span several frames."]);
    check("settling flattens: one text node per paragraph, no spans left",
          host.blocks.every((b) => b.childNodes.length === 1 && b.spans.length === 0),
          JSON.stringify(host.blocks.map((b) => b.childNodes.length)));
  }

  {
    // Catching up after a background stretch is not a performance — hundreds of
    // characters lighting up together is a flash, not a fade
    const { host, flow } = open({ fade: true });
    flow.push("Coming back should just show everything, not flash it all at once.");
    for (let i = 0; i < 4; i++) step(16);     // a few normal frames first
    const before = host.blocks[0].childNodes.length;
    step(2000);
    check("the catch-up frame emits no fade span",
          host.blocks[0].childNodes.length === before + 1 &&
          host.blocks[0].childNodes[before] instanceof FText,
          host.blocks[0].childNodes.length + " nodes after catch-up");
    await settle(flow);
  }

  {
    setHidden(true);
    const { host, flow } = open({ fade: true });
    flow.push("Nobody is watching, so nothing should fade.");
    check("hidden: no fade spans", host.blocks[0].spans.length === 0);
    setHidden(false);
    await settle(flow);
  }

  {
    const { host, flow } = open({ block: null, fade: true });
    flow.push("no paragraphs means no fading");
    await settle(flow);
    check("block:null ignores fade", host.childNodes.length === 1 && host.spans.length === 0);
  }
}

/* ================================================================== */

(async function run() {
  const lite = require(path.join(__dirname, "..", "src", "weir-lite.js"));
  const full = require(path.join(__dirname, "..", "src", "weir.js"));

  await sharedSuite(lite, "weir-lite.js");
  await sharedSuite(full, "weir.js");
  await fadeSuite(full, "weir.js — fade-in");

  console.log("\n" + (fail ? "FAILED  " : "PASSED  ") + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})();
