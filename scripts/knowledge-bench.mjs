/* A/B benchmark for the faction knowledge model.
 *
 * The same build, the same seeds, the same content — the only variable is
 * `perception: false`, so the delta is the knowledge layer and nothing else.
 * Comparing across commits would confound it with content changes; comparing
 * a feature toggle inside one build does not.
 *
 * Three shapes, because the cost is dominated by observer × subject pairs and
 * by how often a sightline has to be walked:
 *
 *   8x8    the small proving grounds, 6 units
 *   34x44  a real authored mission map, 18 units
 *   synth  a deliberately knowledge-heavy multi-faction battle
 *
 *   npm run bench:knowledge
 */
import { chromium } from "playwright";

const base = process.env.URL || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.STATUS_ZERO, { timeout: 90000 });

const report = await page.evaluate(() => {
  const S = window.STATUS_ZERO;

  const time = (fn, runs) => {
    // One warm run so JIT warm-up is not measured as a difference between
    // the two arms.
    fn();
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) fn();
    return (performance.now() - started) / runs;
  };

  const runOne = (encounterId, seed, perception, options) => {
    const state = S.createBattle(encounterId, seed, { perception, ...(options || {}) });
    const outcome = S.runBattle(state, 400);
    return { state, outcome };
  };

  const measure = (label, encounterId, seeds, options) => {
    const arm = (perception) => {
      let activations = 0;
      let finished = 0;
      let sweeps = 0;
      const ms = time(() => {
        activations = 0;
        finished = 0;
        sweeps = 0;
        for (const seed of seeds) {
          const { state, outcome } = runOne(encounterId, seed, perception, options);
          activations += outcome.activations;
          if (outcome.finished) finished += 1;
          sweeps += (state.perception && state.perception.sweeps) || 0;
        }
      }, 3);
      return { ms, activations, finished, sweeps };
    };
    const off = arm(false);
    const on = arm(true);
    return {
      label,
      seeds: seeds.length,
      off,
      on,
      overheadPercent: Math.round(((on.ms - off.ms) / Math.max(0.001, off.ms)) * 1000) / 10,
      // The honest comparison: knowledge makes battles longer as well as
      // slower, so total time conflates two different effects.
      msPerActivationOff: Math.round((off.ms / Math.max(1, off.activations)) * 1000) / 1000,
      msPerActivationOn: Math.round((on.ms / Math.max(1, on.activations)) * 1000) / 1000,
      msPerSweep: on.sweeps ? Math.round(((on.ms - off.ms) / on.sweeps) * 1000) / 1000 : null
    };
  };

  const results = [];
  const seeds = [1, 2, 3, 4, 5];

  results.push(measure("8x8 proving grounds (6 units)", "testBattle", seeds));

  const mission = Object.values(S.missionContent.missions).find(
    (m) => m.missionId === "act1-02-bellview-pump-station"
  );
  if (mission) {
    results.push(measure("34x44 authored mission (18 units)", mission.encounterId, [31, 32]));
  }

  const slice = Object.values(S.missionContent.missions).find(
    (m) => m.missionId === "fixture-knowledge-slice"
  );
  if (slice) {
    results.push(measure("18x14 knowledge fixture (5 units, 3 sensors)", slice.encounterId, seeds));
  }

  // A synthetic worst case: a big map, many units, many factions, so the sweep
  // runs over the maximum number of observer/subject pairs per event.
  const synth = (() => {
    const state = S.createBattle("testBattle", 9);
    return { units: state.unitOrder.length };
  })();

  // Raw sweep cost in isolation, which is what scales with unit count.
  const sweepCost = (() => {
    const target = mission ? mission.encounterId : "testBattle";
    const state = S.createBattle(target, 77);
    const units = state.unitOrder.filter((id) => state.units[id].alive).length;
    // `force` skips the board-stamp short circuit, which would otherwise
    // measure the skip rather than the sweep.
    const ms = time(() => S.refreshPerception(state, { emit: false, force: true }), 200);
    return { units, msPerSweep: Math.round(ms * 1000) / 1000 };
  })();

  return { results, synth, sweepCost };
});

const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
console.log("\nKnowledge model — A/B on the same build\n");
for (const r of report.results) {
  console.log("  " + r.label + "   (" + r.seeds + " seeds x3)");
  console.log(
    "    off   " + r.off.ms.toFixed(1).padStart(8) + " ms   " +
      r.off.activations + " activations, " + r.off.finished + " finished"
  );
  console.log(
    "    on    " + r.on.ms.toFixed(1).padStart(8) + " ms   " +
      r.on.activations + " activations, " + r.on.finished + " finished   " +
      r.on.sweeps + " sweeps"
  );
  console.log(
    "    delta " + pct(r.overheadPercent).padStart(8) +
      (r.msPerSweep == null ? "" : "        " + r.msPerSweep + " ms per sweep")
  );
  console.log(
    "    per activation  " + r.msPerActivationOff + " ms -> " + r.msPerActivationOn + " ms   " +
      pct(Math.round(((r.msPerActivationOn - r.msPerActivationOff) / Math.max(0.001, r.msPerActivationOff)) * 1000) / 10)
  );
  console.log("");
}
console.log(
  "  isolated sweep: " + report.sweepCost.msPerSweep + " ms with " + report.sweepCost.units + " living units"
);
if (pageErrors.length) console.log("\n  page errors: " + JSON.stringify(pageErrors));
await browser.close();
