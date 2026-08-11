/* Browser acceptance for arc propagation.
 *
 * The unit suite proves the search as a function. This drives the thing the
 * phase is actually about, through the real runtime in a real page: a chain
 * that provably cannot reach two enemies, one operator moving a third enemy
 * exactly two tiles, and the same chain — unchanged, unaware of any of it —
 * suddenly reaching all three.
 *
 * The point of every check below is that no engine code connects those two
 * operators. There is forced movement, there are live positions, and there is
 * a search that reads them.
 *
 *   npm run check:cascade
 */
import { chromium } from "playwright";

const base = process.env.URL || "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail == null ? "" : "  [" + detail + "]"));
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
const page = await ctx.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.goto(base + "/", { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.STATUS_ZERO, { timeout: 90000 });

const PRELUDE = `
  const Z = window.STATUS_ZERO;
  const arena = (seed, options) =>
    Z.createBattle("file:fixture-cascade-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: false,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const bank = (state, unitId) => (state.units[unitId].resources || {}).capacitor;
  const refsOf = (state, ids) => ids.map((id) => state.units[id].ref).join(" → ");
`;

/* ---- the operator, and what it is holding ---- */
console.log("the frame");
const frame = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(90);
  const arc = ref(state, "arc");
  const definition = Z.content.units[arc.definitionId];
  const capacitor = bank(state, arc.id);
  return {
    hasFrame: !!definition,
    abilities: definition.abilities,
    capacitorStart: capacitor.current,
    capacitorMax: capacitor.max,
    hp: definition.baseStats.maxHp,
    kellHp: Z.content.units.sniperMech.baseStats.maxHp,
    evasion: definition.baseStats.evasion,
    stealthEvasion: Z.content.units.stealthMech.baseStats.evasion,
    reach: Math.max(...definition.abilities.map((id) => Z.content.abilities[id].targeting.rangeMax)),
    kellReach: Math.max(
      ...Z.content.units.sniperMech.abilities.map((id) => Z.content.abilities[id].targeting.rangeMax)
    )
  };
})()`);

check("1. the cascade frame exists as content", frame.hasFrame, frame.abilities.join(","));
check("   carrying a capacitor bank", frame.capacitorStart > 0 && frame.capacitorMax > frame.capacitorStart,
  frame.capacitorStart + "/" + frame.capacitorMax);
check("2. it is frailer than the sniper", frame.hp < frame.kellHp, frame.hp + " vs " + frame.kellHp);
check("   and less evasive than the stealth frame", frame.evasion < frame.stealthEvasion,
  frame.evasion + " vs " + frame.stealthEvasion);
check("   and cannot outrange the sniper", frame.reach < frame.kellReach,
  frame.reach + " vs " + frame.kellReach);

/* ---- the chain, before anything is moved ---- */
console.log("before");
const before = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(91);
  const arc = ref(state, "arc");
  const alpha = ref(state, "alpha");
  const bravo = ref(state, "bravo");
  const charlie = ref(state, "charlie");
  const plan = Z.propagation.plan(state, arc.id, "chainDischarge", alpha.id);
  const preview = Z.propagation.preview(state, arc.id, "chainDischarge", alpha.id);
  const nearMiss = plan.rejected.find((entry) => entry.id === bravo.id);
  return {
    order: refsOf(state, plan.order),
    legal: plan.legal,
    reached: preview.reached,
    termination: preview.termination,
    nearMissReason: nearMiss ? nearMiss.reason : null,
    alphaToBravo: Math.abs(alpha.x - bravo.x) + Math.abs(alpha.y - bravo.y),
    alphaToCharlie: Math.abs(alpha.x - charlie.x) + Math.abs(alpha.y - charlie.y),
    radius: Z.content.abilities.chainDischarge.propagation.hopRadius,
    cost: preview.costs[0]
  };
})()`);

check("3. the chain is legal but reaches only what was aimed at", before.legal && before.reached === 1,
  before.order);
check("   because the formation is genuinely too spread out",
  before.alphaToBravo > before.radius && before.alphaToCharlie > before.radius,
  "A→B " + before.alphaToBravo + ", A→C " + before.alphaToCharlie + ", radius " + before.radius);
check("   and the preview says why it stops", /nothing else in range/.test(before.termination || ""),
  before.termination);
check("   naming the near miss", /out of arc range/.test(before.nearMissReason || ""), before.nearMissReason);
check("4. the preview quotes the capacitor cost up front",
  before.cost.resourceId === "capacitor" && before.cost.amount > 0 && before.cost.affordable,
  before.cost.amount + " of " + before.cost.available);

/* ---- one operator moves one enemy two tiles ---- */
console.log("the shove");
const shove = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(92);
  const veteran = ref(state, "veteran");
  const arc = ref(state, "arc");
  const alpha = ref(state, "alpha");
  const bravo = ref(state, "bravo");
  const charlie = ref(state, "charlie");
  for (const unit of [alpha, bravo, charlie]) unit.currentHp = 9999;

  const beforeOrder = refsOf(state, Z.propagation.plan(state, arc.id, "chainDischarge", alpha.id).order);

  Z.activateUnitForTest(state, veteran.id);
  const from = { x: bravo.x, y: bravo.y };
  const result = Z.executeCommand(state, {
    type: "trajectory",
    unitId: veteran.id,
    abilityId: "machStrike",
    segments: [
      {
        heading: "w",
        distance: 1,
        contact: { targetUnitId: bravo.id, displace: { heading: "w", distance: 2 } }
      }
    ]
  });

  const afterPlan = Z.propagation.plan(state, arc.id, "chainDischarge", alpha.id);
  const afterPreview = Z.propagation.preview(state, arc.id, "chainDischarge", alpha.id);
  return {
    ok: result.ok,
    errors: result.errors || [],
    beforeOrder,
    movedFrom: from,
    movedTo: { x: bravo.x, y: bravo.y },
    survived: bravo.alive,
    afterOrder: refsOf(state, afterPlan.order),
    reached: afterPreview.reached,
    hopDistances: afterPreview.nodes.slice(1).map((node) => node.distance),
    engineErrors: state.errors.slice()
  };
})()`);

check("5. the veteran's route and shove resolve", shove.ok, (shove.errors || []).join(" | "));
check("   moving one enemy exactly two tiles",
  shove.movedTo.x === shove.movedFrom.x - 2 && shove.movedTo.y === shove.movedFrom.y,
  JSON.stringify(shove.movedFrom) + " → " + JSON.stringify(shove.movedTo));
check("   and leaving it alive to conduct through", shove.survived);
check("6. the same chain now reaches three, having reached one a moment ago",
  shove.beforeOrder === "alpha" && shove.afterOrder === "alpha → bravo → charlie",
  shove.beforeOrder + "  ⇒  " + shove.afterOrder);
check("   with every arc inside the authored radius",
  shove.hopDistances.every((distance) => distance <= 3), shove.hopDistances.join(","));
check("   and no engine errors", shove.engineErrors.length === 0, shove.engineErrors.join(" | "));

/* ---- and it really resolves that way ---- */
console.log("the discharge");
const discharge = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(93);
  const veteran = ref(state, "veteran");
  const arc = ref(state, "arc");
  const alpha = ref(state, "alpha");
  const bravo = ref(state, "bravo");
  const charlie = ref(state, "charlie");
  for (const unit of [alpha, bravo, charlie]) unit.currentHp = 9999;

  Z.activateUnitForTest(state, veteran.id);
  Z.executeCommand(state, {
    type: "trajectory",
    unitId: veteran.id,
    abilityId: "machStrike",
    segments: [
      {
        heading: "w",
        distance: 1,
        contact: { targetUnitId: bravo.id, displace: { heading: "w", distance: 2 } }
      }
    ]
  });

  Z.activateUnitForTest(state, arc.id);
  const promised = Z.propagation
    .preview(state, arc.id, "chainDischarge", alpha.id)
    .nodes.map((node) => state.units[node.unitId].ref)
    .join(" → ");
  const capacitorBefore = bank(state, arc.id).current;
  const logBefore = state.battleLog.length;
  // The veteran's own strike is a separate chain, correctly. Only the events
  // the discharge produces are being asked about here.
  const traceBefore = Z.causalTrace(state).length;

  const result = Z.executeCommand(state, {
    type: "useAbility",
    unitId: arc.id,
    abilityId: "chainDischarge",
    target: { unitId: alpha.id, tile: { x: alpha.x, y: alpha.y } }
  });

  const fresh = state.battleLog.slice(logBefore);
  const struck = fresh
    .filter((entry) => entry.type === "damageResolved")
    .map((entry) => state.units[entry.data.unitId].ref);
  const damage = fresh
    .filter((entry) => entry.type === "damageResolved")
    .map((entry) => entry.data.amount);

  const trace = Z.causalTrace(state)
    .slice(traceBefore)
    .filter((entry) => entry.type === "damageResolved");
  const roots = new Set(trace.map((entry) => entry.cause && entry.cause.rootSeq));

  return {
    ok: result.ok,
    errors: result.errors || [],
    promised,
    struck: struck.join(" → "),
    unique: new Set(struck).size === struck.length,
    damage,
    hopLines: fresh.filter((entry) => entry.type === "propagationHop").length,
    plannedLine: fresh.some((entry) => entry.type === "propagationPlanned"),
    completedLine: fresh.find((entry) => entry.type === "propagationCompleted"),
    capacitorBefore,
    capacitorAfter: bank(state, arc.id).current,
    causalRoots: roots.size,
    continuation: Z.battleContinuation(state).kind,
    engineErrors: state.errors.slice()
  };
})()`);

check("7. the discharge resolves", discharge.ok, (discharge.errors || []).join(" | "));
check("   striking exactly what the preview promised",
  discharge.struck === discharge.promised, discharge.struck + "  vs  " + discharge.promised);
check("   in order, with nobody hit twice", discharge.unique, discharge.struck);
check("8. each arc is worth less than the last",
  discharge.damage[0] > discharge.damage[1] && discharge.damage[1] > discharge.damage[2],
  discharge.damage.join(" → "));
check("   and ordinary frames take serious damage",
  Math.min(...discharge.damage) > 60, discharge.damage.join(","));
check("9. the capacitor pays for it",
  discharge.capacitorAfter === discharge.capacitorBefore - 3,
  discharge.capacitorBefore + " → " + discharge.capacitorAfter);
check("10. the log shows the chain and every jump in it",
  discharge.plannedLine && discharge.hopLines === 2 && !!discharge.completedLine,
  discharge.hopLines + " arcs logged");
check("    and the causal record puts them all on one chain",
  discharge.causalRoots === 1, "roots: " + discharge.causalRoots);
check("11. the battle carries on", discharge.continuation !== "stalled", discharge.continuation);
check("    with no engine errors", discharge.engineErrors.length === 0,
  discharge.engineErrors.join(" | "));

/* ---- a formation that made the mistake ---- */
console.log("the pack");
const pack = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(94);
  const arc = ref(state, "arc");
  const packA = ref(state, "packA");
  bank(state, arc.id).current = 8;
  // Walk the frame into range of the two-by-two block it exists to answer.
  arc.x = packA.x - 3;
  arc.y = packA.y;
  Z.activateUnitForTest(state, arc.id);

  const preview = Z.propagation.preview(state, arc.id, "surgeDischarge", packA.id);
  const before = state.unitOrder.filter((id) => state.units[id].alive).length;
  Z.executeCommand(state, {
    type: "useAbility",
    unitId: arc.id,
    abilityId: "surgeDischarge",
    target: { unitId: packA.id, tile: { x: packA.x, y: packA.y } }
  });
  const completed = state.battleLog.filter((entry) => entry.type === "propagationCompleted").pop();
  return {
    reached: preview.reached,
    lethalForecast: preview.lethalCount,
    killed: before - state.unitOrder.filter((id) => state.units[id].alive).length,
    kills: completed ? completed.data.kills : 0,
    plans: state.battleLog.filter((entry) => entry.type === "propagationPlanned").length,
    capacitor: bank(state, arc.id).current,
    continuation: Z.battleContinuation(state).kind,
    engineErrors: state.errors.slice()
  };
})()`);

check("12. a tight block is reached in full", pack.reached >= 4, pack.reached + " nodes");
check("    and several die in one cast", pack.killed >= 3, pack.killed + " destroyed");
check("    which the preview warned about", pack.lethalForecast >= 3, pack.lethalForecast + " forecast lethal");
check("13. a kill feeds the rest of the chain but never starts another",
  pack.kills >= 3 && pack.plans === 1, pack.kills + " kills, " + pack.plans + " chain planned");
check("    and the bank is spent", pack.capacitor === 2, pack.capacitor);
check("    with no engine errors", pack.engineErrors.length === 0, pack.engineErrors.join(" | "));

/* ---- counterplay ---- */
console.log("counterplay");
const counter = await page.evaluate(`(() => {
  ${PRELUDE}
  // An empty bank: the action is honestly unavailable, not a failed click.
  const empty = arena(95);
  const arc = ref(empty, "arc");
  const alpha = ref(empty, "alpha");
  alpha.currentHp = 9999;
  Z.activateUnitForTest(empty, arc.id);
  bank(empty, arc.id).current = 1;
  const command = {
    type: "useAbility",
    unitId: arc.id,
    abilityId: "chainDischarge",
    target: { unitId: alpha.id, tile: { x: alpha.x, y: alpha.y } }
  };
  const validation = Z.validateCommand(empty, command);
  const ran = Z.executeCommand(empty, command);

  // Charging costs a whole activation and leaves the frame exposed.
  const charging = arena(96);
  const spooler = ref(charging, "arc");
  Z.activateUnitForTest(charging, spooler.id);
  const chargedFrom = bank(charging, spooler.id).current;
  Z.executeCommand(charging, {
    type: "useAbility",
    unitId: spooler.id,
    abilityId: "groundingCycle",
    target: { unitId: spooler.id, tile: { x: spooler.x, y: spooler.y } }
  });
  const exposed = spooler.statuses.some((entry) => entry.statusId === "grounding");

  // An elite survives the whole chain and is still standing.
  const tough = arena(97);
  const shooter = ref(tough, "arc");
  const elite = ref(tough, "elite");
  bank(tough, shooter.id).current = 8;
  shooter.x = elite.x - 3;
  shooter.y = elite.y;
  Z.activateUnitForTest(tough, shooter.id);
  Z.executeCommand(tough, {
    type: "useAbility",
    unitId: shooter.id,
    abilityId: "chainDischarge",
    target: { unitId: elite.id, tile: { x: elite.x, y: elite.y } }
  });

  return {
    refused: validation.valid === false,
    reason: validation.errors.join(" | "),
    ranAnyway: ran.ok,
    untouched: alpha.currentHp === 9999,
    banked: bank(charging, spooler.id).current > chargedFrom,
    exposed,
    eliteAlive: elite.alive,
    eliteHp: elite.currentHp,
    engineErrors: empty.errors.concat(charging.errors, tough.errors)
  };
})()`);

check("14. an empty bank refuses the chain", counter.refused && !counter.ranAnyway, counter.reason);
check("    and nobody is struck by the attempt", counter.untouched);
check("15. charging banks power at the cost of an activation", counter.banked);
check("    and leaves the frame exposed while it does", counter.exposed);
check("16. an elite survives a full chain and is still standing",
  counter.eliteAlive, counter.eliteHp + " HP left");
check("    with no engine errors", counter.engineErrors.length === 0, counter.engineErrors.join(" | "));

/* ---- performance on a crowded board ---- */
console.log("performance");
const perf = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(98);
  const arc = ref(state, "arc");
  const alpha = ref(state, "alpha");
  const template = JSON.stringify(state.units[alpha.id]);
  let placed = 0;
  for (let y = 3; y < 15 && placed < 46; y += 1) {
    for (let x = 7; x < 21 && placed < 46; x += 1) {
      if (x === arc.x && y === arc.y) continue;
      const id = "perf" + placed;
      state.units[id] = { ...JSON.parse(template), id, ref: id, x, y };
      state.unitOrder.push(id);
      placed += 1;
    }
  }
  const timed = (fn, runs) => {
    const started = performance.now();
    for (let index = 0; index < runs; index += 1) fn();
    return (performance.now() - started) / runs;
  };
  return {
    units: state.unitOrder.length,
    planMs: timed(() => Z.propagation.plan(state, arc.id, "surgeDischarge", alpha.id), 300),
    previewMs: timed(() => Z.propagation.preview(state, arc.id, "surgeDischarge", alpha.id), 100)
  };
})()`);

console.log(
  "    " + perf.units + " units · plan " + perf.planMs.toFixed(3) +
    "ms · full preview " + perf.previewMs.toFixed(3) + "ms"
);
check("17. planning stays cheap on a crowded board", perf.planMs < 5, perf.planMs.toFixed(3) + "ms");
check("    and a full preview redraw does too", perf.previewMs < 25, perf.previewMs.toFixed(3) + "ms");

/* ---- the Studio can author all of it ---- */
console.log("studio");
await page.evaluate(() => {
  localStorage.removeItem("statuszero.gameplay.editorDraft");
  localStorage.removeItem("statuszero.gameplay.draft");
  localStorage.removeItem("statuszero.editor.mode");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1600);
await page.getByRole("button", { name: /^Gameplay Data$/ }).first().click();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /^Abilities$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /chainDischarge/ }).first().click();
await page.waitForTimeout(600);
check("18. the chaining action opens in the Studio", /Chain Discharge/i.test(await page.locator("body").innerText()));
await page.getByRole("button", { name: /^Propagation$/ }).first().click();
await page.waitForTimeout(500);
const propagationText = await page.locator("body").innerText();
for (const label of ["Maximum arcs", "Arc range", "Arcs to", "Chooses", "Node filters"]) {
  check("    " + label + " is editable", new RegExp(label, "i").test(propagationText));
}

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));

  const unknownPolicy = clone();
  unknownPolicy.abilities.chainDischarge.propagation.selection = "whimsy";

  const negative = clone();
  negative.abilities.chainDischarge.propagation.hopRadius = -2;

  const loop = clone();
  loop.abilities.chainDischarge.propagation.allowRepeat = true;
  loop.abilities.chainDischarge.propagation.includeSource = true;

  const nested = clone();
  nested.abilities.chainDischarge.effects[0].effects.push({
    type: "applyStatus",
    statusId: "noSuchStatus",
    chance: 1
  });

  return {
    clean: validate.validateGameplayData(registry.CANONICAL_GAMEPLAY).errors.length,
    unknownPolicy: validate.validateGameplayData(unknownPolicy).errors.some((m) => /whimsy/.test(m)),
    negative: validate.validateGameplayData(negative).ok === false,
    loopWarned: validate.validateGameplayData(loop).warnings.some((m) => /bounce between two nodes/.test(m)),
    nested: validate.validateGameplayData(nested).errors.some((m) => /noSuchStatus/.test(m)),
    runningHops: window.STATUS_ZERO.content.abilities.chainDischarge.propagation.maxHops
  };
});
check("19. the shipped data validates", authoring.clean === 0, authoring.clean);
check("    an unknown selection policy is refused", authoring.unknownPolicy);
check("    a negative arc range is refused", authoring.negative);
check("    a configuration that would bounce between two nodes is called out", authoring.loopWarned);
check("    and a dangling reference nested inside the chain is caught", authoring.nested);
check("    while the running content is untouched", authoring.runningHops === 3);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("20. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
