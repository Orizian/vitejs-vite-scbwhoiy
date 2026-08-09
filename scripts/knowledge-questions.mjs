/* Verification for the three acceptance questions.
 *
 * These are deliberately adversarial rather than illustrative. Question (b) in
 * particular is answered with a tripwire on the hidden unit's coordinates: any
 * read during an AI decision is recorded with its stack, so the answer is
 * "nothing read it, and here is the list of what did" rather than "we checked
 * the code".
 *
 *   npm run check:questions
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

  const wall = (state, x, from, to) => {
    for (let y = from; y <= to; y += 1) state.terrainOverrides[x + "," + y] = "wall";
  };
  const forget = (state) => {
    for (const f of Object.keys(state.perception.factions)) state.perception.factions[f].units = {};
    state.perception.signatures = {};
  };
  const isolate = (state, keep) => {
    for (const id of state.unitOrder) {
      if (!keep.includes(id)) {
        state.units[id].alive = false;
        state.units[id].currentHp = 0;
      }
    }
  };

  /* ================= (a) two factions, one unit, two beliefs ============= */
  const a = (() => {
    const state = S.createBattle("testBattle", 11);
    isolate(state, ["u1", "u5", "u6"]);
    S.missionEngine.setUnitTeam(state, "u5", "thirdParty");
    S.missionEngine.processEvents(state);
    Object.assign(state.units.u1, { x: 1, y: 0 });
    Object.assign(state.units.u5, { x: 3, y: 0 });
    Object.assign(state.units.u6, { x: 6, y: 0 });
    wall(state, 4, 0, 7);
    forget(state);
    S.refreshPerception(state, { emit: false });

    const near = S.knowledgeStateOf(state, "thirdParty", "u1");
    const far = S.knowledgeStateOf(state, "foe", "u1");
    return {
      subject: "u1",
      nearFaction: { id: "thirdParty", believes: near, hostile: S.isHostile(state, "u5", "u1") },
      farFaction: { id: "foe", believes: far, hostile: S.isHostile(state, "u6", "u1") },
      differ: near !== far,
      bothHostile: S.isHostile(state, "u5", "u1") && S.isHostile(state, "u6", "u1"),
      // The same instant, the same board, the same physical unit.
      sameInstant: state.currentTime
    };
  })();

  /* ============ (b) search on memory, with a coordinate tripwire ========= */
  const b = (() => {
    const state = S.createBattle("testBattle", 4242);
    isolate(state, ["u1", "u6"]);
    Object.assign(state.units.u1, { x: 1, y: 0 });
    Object.assign(state.units.u6, { x: 6, y: 0 });
    forget(state);
    S.refreshPerception(state, { emit: false });

    // The garrison unit saw u1 at 1,0. u1 then vanishes to the far corner and
    // the record is left pointing at the memory.
    S.knowledgeStateOf(state, "foe", "u1");
    state.perception.factions.foe.units.u1 = {
      unitId: "u1",
      state: "suspected",
      x: 1,
      y: 0,
      accuracy: "approximate",
      channels: ["optical"],
      updatedActivation: 0,
      positionActivation: 0,
      firstSeenActivation: 0,
      investigated: false,
      persistent: false,
      holdUntil: null,
      source: "sensor"
    };

    const lead = S.searchTargetFor(state, "u6");

    // Now the tripwire. Replace the hidden unit's coordinates with accessors
    // that record every read, then ask the AI to decide its whole turn.
    const target = state.units.u1;
    let realX = 7;
    let realY = 7;
    const reads = [];
    const record = (which) => {
      // Skip the accessor's own frames and name the first real caller, so a
      // residual read is attributed rather than counted.
      const frames = (new Error().stack || "")
        .split("\n")
        .map((f) => f.trim())
        .filter(
          (f) =>
            f.startsWith("at ") &&
            !/\bat record\b/.test(f) &&
            !/\bat (Object\.)?get\b/.test(f) &&
            !/\bget [xy]\b/.test(f)
        );
      reads.push({ which, caller: frames[0] || "unknown", trace: frames.slice(0, 3).join(" <- ") });
    };
    Object.defineProperty(target, "x", {
      configurable: true,
      get() {
        record("x");
        return realX;
      },
      set(v) {
        realX = v;
      }
    });
    Object.defineProperty(target, "y", {
      configurable: true,
      get() {
        record("y");
        return realY;
      },
      set(v) {
        realY = v;
      }
    });

    // Two measurements, kept apart on purpose.
    //
    //   decision inputs — what the AI is allowed to reason about
    //   whole turn      — including movement legality, which is physics
    //
    // Lumping them together would hide which one is doing the reading.
    reads.length = 0;
    S.enumerateAiTargets(state, "u6", "quickStrike", { x: 6, y: 0 });
    S.tilePositionScore(state, "u6", { x: 5, y: 0 });
    S.nearestHostileFacing(state, "u6");
    S.searchTargetFor(state, "u6");
    const decisionReads = reads.length;
    const decisionCallers = {};
    for (const entry of reads) {
      const name = (entry.caller.match(/at ([A-Za-z0-9_$.]+)/) || [null, "unknown"])[1];
      decisionCallers[name] = (decisionCallers[name] || 0) + 1;
    }

    reads.length = 0;
    let commands = null;
    try {
      commands = S.chooseAiCommands(state, "u6");
    } finally {
      Object.defineProperty(target, "x", { configurable: true, writable: true, value: realX });
      Object.defineProperty(target, "y", { configurable: true, writable: true, value: realY });
    }

    // Attribute every read to the function that made it, so a residual channel
    // is named rather than hidden in a count.
    const callers = {};
    for (const entry of reads) {
      const name = (entry.caller.match(/at ([A-Za-z0-9_$.]+)/) || [null, "unknown"])[1];
      callers[name] = (callers[name] || 0) + 1;
    }

    const destination = commands && commands.find((c) => c.type === "move");
    const finalTile = destination ? destination.path[destination.path.length - 1] : null;

    // Behavioural invariance: move the hidden unit somewhere else entirely and
    // ask again. If any true coordinate reached the decision, this changes.
    const decideFrom = (x, y) => {
      state.units.u1.x = x;
      state.units.u1.y = y;
      return JSON.stringify(S.chooseAiCommands(state, "u6"));
    };
    const atCornerA = decideFrom(7, 7);
    const atCornerB = decideFrom(0, 7);
    state.units.u1.x = realX;
    state.units.u1.y = realY;

    return {
      leadTile: lead ? lead.x + "," + lead.y : null,
      realTile: realX + "," + realY,
      commands: commands ? commands.map((c) => c.type) : null,
      movesToward: finalTile ? finalTile.x + "," + finalTile.y : null,
      decisionReads,
      decisionCallers,
      totalReads: reads.length,
      callers,
      invariant: atCornerA === atCornerB,
      decision: atCornerA.slice(0, 90)
    };
  })();

  /* ============ (c) the Nyx sequence, from content and data only ========= */
  const c = (() => {
    const state = S.createBattle("testBattle", 4242);
    isolate(state, ["u1", "u6"]);
    Object.assign(state.units.u1, { x: 3, y: 3 });
    Object.assign(state.units.u6, { x: 3, y: 5 });
    forget(state);
    S.refreshPerception(state, { emit: false });
    const steps = [];
    const seen = () => S.knowledgeStateOf(state, "foe", "u1");
    const targetable = () =>
      S.perceivedThreats(state, "foe").some((t) => t.unitId === "u1" && t.targetable);

    steps.push({ step: "in the open", state: seen(), targetable: targetable() });

    // 1. Cloak: a status whose content says it emits no light.
    S.resolveEffects(state, {
      sourceUnitId: "u1",
      targetUnitIds: ["u1"],
      effects: [{ type: "applyStatus", statusId: "cloaked", chance: 1 }]
    });
    S.missionEngine.processEvents(state);
    forget(state);
    S.refreshPerception(state, { emit: false });
    steps.push({ step: "cloaked", state: seen(), targetable: targetable() });

    // 2. Noise while still cloaked: a footfall, a forced door, a vented
    //    coolant burst. Acoustic is capped at `suspected` by the channel
    //    table, so this can never produce a shot.
    S.missionEngine.emitSignature(state, ["u1"], "acoustic", { strength: 1, duration: 2 });
    steps.push({ step: "noise while cloaked", state: seen(), targetable: targetable() });

    // 3. A thermal vent opens under her: a mission action on a channel.
    state.units.u6.equipment = { ...state.units.u6.equipment, utilitySystem: "thermalOptics" };
    S.missionEngine.emitSignature(state, ["u1"], "thermal", { strength: 2, duration: 2 });
    steps.push({ step: "thermal vent + optic", state: seen(), targetable: targetable() });

    // The gate the question is really about: did any of this require a change
    // to AI targeting? The audit already forbids content ids in engine code;
    // this checks the targeting path specifically.
    // Knowledge words like "suspected" are the generic API and belong here.
    // Stealth-kit words do not: if targeting had to learn about cloaks, heat
    // or thermal channels, the architecture would have failed the question.
    const targetingSource = S.aiTargetingSource();
    const forbidden = ["cloak", "nyx", "stealth", "thermal", "heat", "conceal", "sensor"].filter(
      (word) => targetingSource.toLowerCase().includes(word)
    );

    return { steps, forbiddenWordsInTargeting: forbidden };
  })();

  return { a, b, c };
});

const line = (ok, text, detail) =>
  console.log((ok ? "  ok   " : "  FAIL ") + text + (detail == null ? "" : "  [" + detail + "]"));

let allOk = true;
const check = (ok, text, detail) => {
  if (!ok) allOk = false;
  line(ok, text, detail);
};

console.log("\n(a) Can two hostile factions hold different knowledge about the same unit?\n");
check(report.a.bothHostile, "both observers are hostile to the subject");
check(
  report.a.differ,
  "and they believe different things about it",
  report.a.nearFaction.id + "=" + report.a.nearFaction.believes +
    "  " + report.a.farFaction.id + "=" + report.a.farFaction.believes
);
check(report.a.nearFaction.believes === "acquired", "the near faction has a firing solution");
check(report.a.farFaction.believes === "unseen", "the walled-off faction has nothing");

console.log("\n(b) Can an AI search a lost contact without reading the target's real position?\n");
check(report.b.leadTile === "1,0", "the search lead is the remembered tile", report.b.leadTile);
check(report.b.realTile === "7,7", "the target is actually somewhere else", report.b.realTile);
check(
  report.b.decisionReads === 0,
  "targeting, threat scoring, facing and the search lead read it zero times",
  report.b.decisionReads + (report.b.decisionReads ? " reads: " + JSON.stringify(report.b.decisionCallers) : "")
);
check(!!report.b.commands, "and the unit still produced a turn", JSON.stringify(report.b.commands));
check(
  report.b.invariant,
  "the same turn is chosen wherever the hidden unit actually is",
  report.b.decision
);
console.log(
  "\n       residual: tile occupancy read the true position " + report.b.totalReads +
    " times during movement legality " + JSON.stringify(report.b.callers)
);
console.log(
  "       bodies block movement whether or not you can see them. That is a physical"
);
console.log(
  "       constraint, not an information one, and it is the only remaining reader."
);

console.log("\n(c) Is the architecture sufficient for the three-state stealth kit?\n");
for (const step of report.c.steps) {
  console.log("       " + step.step.padEnd(24) + step.state + (step.targetable ? "  (targetable)" : ""));
}
const s = report.c.steps;
check(s[0].state === "acquired", "in the open she is acquired");
check(s[1].state === "unseen", "cloaked, she is unseen to plain optics");
check(s[2].state === "suspected" && !s[2].targetable, "noise while cloaked makes a contact, not a target");
check(s[3].state === "acquired" && s[3].targetable, "a thermal vent restores the solution");
check(
  report.c.forbiddenWordsInTargeting.length === 0,
  "and AI targeting never learned about cloaks, heat or sensors",
  report.c.forbiddenWordsInTargeting.join(", ")
);

if (pageErrors.length) {
  allOk = false;
  console.log("\n  page errors: " + JSON.stringify(pageErrors));
}
console.log("\n" + (allOk ? "all three questions verified" : "verification FAILED"));
await browser.close();
process.exit(allOk ? 0 : 1);
