/* Browser acceptance for commanded sequencing.
 *
 * The unit suite proves the model as functions. This drives the thing the
 * phase is actually about, through the real runtime in a real page: the
 * natural order is the wrong one, a commander reorders it, and every unit
 * still takes exactly one turn.
 *
 * The count checks are the point. "Nobody acts twice and nobody loses a turn"
 * is not observable from a screenshot — it is observable from counting
 * activations, so that is what these do.
 *
 *   npm run check:command
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
    Z.createBattle("file:fixture-command-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: true,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const refOf = (state, unitId) => state.units[unitId].ref;
  /* Activate the commander, THEN lay out the queue: activating flattens every
   * other unit's clock, which is exactly what these checks need not to be. */
  const stage = (state, actorRef, upcoming, step) => {
    const actor = ref(state, actorRef);
    Z.activateUnitForTest(state, actor.id);
    const base = state.currentTime + 100;
    upcoming.forEach((name, index) => {
      ref(state, name).nextActionTime = base + index * (step == null ? 100 : step);
    });
    const named = new Set(upcoming.map((name) => ref(state, name).id));
    named.add(actor.id);
    for (const id of state.unitOrder) {
      if (!named.has(id)) state.units[id].nextActionTime = base + 100000;
    }
    return actor;
  };
  const queued = (state, count) =>
    Z.sequencing.upcoming(state)
      .filter((id) => id !== state.activeUnitId)
      .slice(0, count == null ? 6 : count)
      .map((id) => refOf(state, id));
  const ids = (state, names) => names.map((name) => ref(state, name).id);
  const issue = (state, actorRef, order) =>
    Z.executeCommand(state, {
      type: "reorderActivations",
      unitId: ref(state, actorRef).id,
      abilityId: "battlePlan",
      order: ids(state, order)
    });
  const live = (state) => {
    const next = Z.battleContinuation(state);
    return next.kind !== "stalled" ? null : next.kind + ": " + (next.reason || "");
  };
  const activationsOf = (state, unitId) =>
    state.battleLog.filter((e) => e.type === "unitActivated" && e.data.unitId === unitId).length;
`;

/* ---- 1. the natural order is the wrong one ---- */
console.log("the problem");
const natural = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(500);
  stage(state, "vale", ["reyes", "veteran", "nyx", "kell"]);
  const plan = Z.sequencing.plan(state, ref(state, "vale").id, "battlePlan");
  return {
    order: queued(state, 4),
    eligible: plan.eligibleIds.map((id) => refOf(state, id)),
    maxUnits: plan.maxUnits,
    active: refOf(state, state.activeUnitId),
    stall: live(state)
  };
})()`);
check("1. the bench opens on a deliberately bad order", natural.order.join(",") === "reyes,veteran,nyx,kell", natural.order.join(","));
check("   the commander is the one acting", natural.active === "vale");
check("   and every waiting ally is commandable", natural.eligible.join(",") === "reyes,veteran,nyx,kell", natural.eligible.join(","));

/* ---- 2. the window and its barriers ---- */
console.log("\nthe window");
const window = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(501);
  stage(state, "vale", ["kell", "reyes", "blocker", "nyx"]);
  const plan = Z.sequencing.plan(state, ref(state, "vale").id, "battlePlan");
  const model = Z.sequencing.preview(state, ref(state, "vale").id, "battlePlan", ids(state, ["kell"]));
  const behind = plan.entries.find((e) => e.unitId === ref(state, "nyx").id);
  const far = arena(502);
  stage(far, "vale", ["kell", "reyes"]);
  ref(far, "nyx").nextActionTime = far.currentTime + 90000;
  const farPlan = Z.sequencing.plan(far, ref(far, "vale").id, "battlePlan");
  return {
    eligible: plan.eligibleIds.map((id) => refOf(state, id)),
    barrier: plan.barrier ? refOf(state, plan.barrier.unitId) : null,
    behindReason: behind ? behind.reason : null,
    modelBarrier: model.barrier ? model.barrier.name : null,
    costText: model.costText,
    hostileShown: model.entries.some((e) => e.hostile && !e.eligible),
    everyExclusionExplained: model.entries.every((e) => e.eligible || !!e.reason),
    farEligible: farPlan.eligibleIds.map((id) => refOf(far, id)),
    farReason: (farPlan.entries.find((e) => e.unitId === ref(far, "nyx").id) || {}).reason
  };
})()`);
check("2. the window stops at the first enemy", window.eligible.join(",") === "kell,reyes", window.eligible.join(","));
check("   the barrier is named", window.barrier === "blocker");
check("   the ally behind it says why it is unavailable", /enemy acts first/i.test(window.behindReason || ""), window.behindReason);
check("   the panel shows the barrier too", !!window.modelBarrier, window.modelBarrier);
check("   the enemy is visible in the window, and visibly unavailable", window.hostileShown);
check("   every exclusion carries a reason", window.everyExclusionExplained);
check("   the cost is stated in words", window.costText === "2 Command Points", window.costText);
check("   a far-future ally cannot be pulled in", !window.farEligible.includes("nyx"), window.farEligible.join(","));
check("   and says why", /too far ahead/i.test(window.farReason || ""), window.farReason);

/* ---- 3. preview parity ---- */
console.log("\npreview and execution agree");
const parity = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(503);
  const vale = stage(state, "vale", ["reyes", "veteran", "nyx", "kell"]);
  const wanted = ids(state, ["kell", "reyes", "veteran", "nyx"]);
  const model = Z.sequencing.preview(state, vale.id, "battlePlan", wanted);
  // The projection covers the whole upcoming list; the comparison is against
  // who is queued behind the commander, so drop her and take the same count.
  const predicted = model.resultingOrder
    .filter((id) => id !== state.activeUnitId)
    .slice(0, 4)
    .map((id) => refOf(state, id));
  const result = issue(state, "vale", ["kell", "reyes", "veteran", "nyx"]);
  return {
    previewOk: model.ok,
    affordable: model.affordable,
    predicted,
    actual: queued(state, 4),
    ok: result.ok,
    errors: result.errors || [],
    stall: live(state)
  };
})()`);
check("3. the preview accepts the order", parity.previewOk && parity.affordable);
check("   the command accepts it too", parity.ok, parity.errors.join("|"));
check(
  "   and what was promised is what happened",
  parity.predicted.join(",") === parity.actual.join(","),
  parity.predicted.join(",") + " vs " + parity.actual.join(",")
);
check("   the battle has somewhere to go", parity.stall === null, parity.stall);

/* ---- 4. the invariant, counted ---- */
console.log("\nnobody acts twice, nobody loses a turn");
const invariant = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(504);
  const vale = stage(state, "vale", ["reyes", "veteran", "nyx", "kell"]);
  const before = Z.sequencing.upcoming(state).map((id) => refOf(state, id)).sort().join(",");
  const cpBefore = Z.combatResources.faction(state, vale.teamId).commandPoints.current;
  issue(state, "vale", ["kell", "reyes", "veteran", "nyx"]);
  const cpAfter = Z.combatResources.faction(state, vale.teamId).commandPoints.current;
  Z.executeCommand(state, { type: "endTurn", unitId: vale.id });

  const commanded = ["kell", "reyes", "veteran", "nyx"];
  const seen = [];
  const stalls = [];
  for (let index = 0; index < commanded.length; index += 1) {
    const nextRef = queued(state, 1)[0];
    seen.push(nextRef);
    Z.runActivation(state);
    const stall = live(state);
    if (stall) stalls.push(nextRef + ": " + stall);
  }
  const counts = {};
  for (const name of commanded) counts[name] = activationsOf(state, ref(state, name).id);
  return {
    before,
    after: Z.sequencing.upcoming(state).map((id) => refOf(state, id)).sort().join(","),
    seen,
    counts,
    cpSpent: cpBefore - cpAfter,
    stalls,
    sequenceEmpty: !Z.sequencing.active(state)
  };
})()`);
check("4. the commanded order is the order that happened", invariant.seen.join(",") === "kell,reyes,veteran,nyx", invariant.seen.join(","));
check("   every commanded unit acted exactly once", Object.values(invariant.counts).every((n) => n === 1), JSON.stringify(invariant.counts));
check("   the same units still own the timeline", invariant.before === invariant.after);
check("   the squad paid exactly twice", invariant.cpSpent === 2, String(invariant.cpSpent));
check("   the command retires when it is spent", invariant.sequenceEmpty);
check("   and nothing stalled along the way", invariant.stalls.length === 0, invariant.stalls.join(" | "));

/* ---- 5. refusals ---- */
console.log("\nrefusals");
const refusals = await page.evaluate(`(() => {
  ${PRELUDE}
  const crossing = arena(505);
  stage(crossing, "vale", ["kell", "blocker", "nyx"]);
  const orderBefore = queued(crossing, 3);
  const crossed = issue(crossing, "vale", ["nyx", "kell"]);

  const poor = arena(506);
  const poorVale = stage(poor, "vale", ["reyes", "kell"]);
  Z.combatResources.faction(poor, poorVale.teamId).commandPoints.current = 1;
  const broke = issue(poor, "vale", ["kell", "reyes"]);

  const same = arena(507);
  stage(same, "vale", ["kell", "reyes"]);
  const unchanged = issue(same, "vale", ["kell", "reyes"]);

  const dup = arena(508);
  const dupVale = stage(dup, "vale", ["kell", "reyes"]);
  const doubled = Z.executeCommand(dup, {
    type: "reorderActivations",
    unitId: dupVale.id,
    abilityId: "battlePlan",
    order: [ref(dup, "kell").id, ref(dup, "kell").id]
  });

  return {
    crossedRefused: crossed.ok === false,
    crossedReason: (crossed.errors || []).join(" | "),
    crossedUnmoved: queued(crossing, 3).join(",") === orderBefore.join(","),
    brokeRefused: broke.ok === false,
    brokeReason: (broke.errors || []).join(" | "),
    brokeUnspent: poor.activation ? poor.activation.acted === false : false,
    unchangedRefused: unchanged.ok === false,
    unchangedReason: (unchanged.errors || []).join(" | "),
    dupRefused: doubled.ok === false,
    dupReason: (doubled.errors || []).join(" | ")
  };
})()`);
check("5. an order that steps over an enemy is refused", refusals.crossedRefused, refusals.crossedReason);
check("   with the timeline untouched", refusals.crossedUnmoved);
check("   an unaffordable command is refused", refusals.brokeRefused, refusals.brokeReason);
check("   without spending the action to find out", refusals.brokeUnspent);
check("   confirming the existing order is refused", refusals.unchangedRefused, refusals.unchangedReason);
check("   and a duplicated pick is refused", refusals.dupRefused, refusals.dupReason);

/* ---- 6. living with the rest of the engine ---- */
console.log("\nthe rest of the engine");
const coexist = await page.evaluate(`(() => {
  ${PRELUDE}
  /* a commanded unit dies before its slot */
  const dies = arena(509);
  const diesVale = stage(dies, "vale", ["reyes", "veteran", "kell"]);
  issue(dies, "vale", ["kell", "reyes", "veteran"]);
  Z.executeCommand(dies, { type: "endTurn", unitId: diesVale.id });
  const kell = ref(dies, "kell");
  kell.currentHp = 0;
  kell.alive = false;
  Z.settleBattle(dies);

  /* a commanded unit is rescheduled */
  const moved = arena(510);
  const movedVale = stage(moved, "vale", ["reyes", "veteran", "kell"]);
  issue(moved, "vale", ["kell", "reyes", "veteran"]);
  Z.executeCommand(moved, { type: "endTurn", unitId: movedVale.id });
  const orderedBefore = queued(moved, 3);
  Z.modifyTurnDelay(moved, ref(moved, "reyes").id, 900);
  Z.settleBattle(moved);

  /* save and reload mid-window */
  const saved = arena(511);
  const savedVale = stage(saved, "vale", ["reyes", "veteran", "nyx", "kell"]);
  issue(saved, "vale", ["kell", "reyes", "veteran", "nyx"]);
  Z.executeCommand(saved, { type: "endTurn", unitId: savedVale.id });
  Z.runActivation(saved);
  const remaining = queued(saved, 3);
  const restored = Z.deserializeBattle(Z.serializeBattle(saved));

  return {
    deadSkipped: queued(dies, 1)[0] === "reyes",
    noGhost: !Z.sequencing.order(dies).includes(kell.id),
    deadStall: live(dies),
    orderedBefore,
    rescheduledDropped: !Z.sequencing.order(moved).includes(ref(moved, "reyes").id),
    rescheduledLogged: moved.battleLog.some((e) => e.type === "activationOrderDropped"),
    remaining,
    restoredRemaining: queued(restored, 3),
    restoredEntries: Z.sequencing.entries(restored).length,
    savedEntries: Z.sequencing.entries(saved).length,
    restoredStall: live(restored)
  };
})()`);
check("6. a commanded unit that died is skipped", coexist.deadSkipped);
check("   leaving no ghost slot", coexist.noGhost);
check("   and the battle still has somewhere to go", coexist.deadStall === null, coexist.deadStall);
check("   a rescheduled unit leaves the commanded order", coexist.rescheduledDropped, coexist.orderedBefore.join(","));
check("   and the log says so rather than the order changing quietly", coexist.rescheduledLogged);
check(
  "   a save mid-window resumes on the same remaining order",
  coexist.remaining.join(",") === coexist.restoredRemaining.join(","),
  coexist.remaining.join(",") + " vs " + coexist.restoredRemaining.join(",")
);
check("   carried rather than re-derived", coexist.restoredEntries === coexist.savedEntries, coexist.restoredEntries + " vs " + coexist.savedEntries);
check("   and stays playable", coexist.restoredStall === null, coexist.restoredStall);

/* ---- 7. the synergy the command exists for ---- */
console.log("\nthe reason it exists");
const synergy = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(512);
  const vale = stage(state, "vale", ["veteran", "kell"]);
  const naturalOrder = queued(state, 2);

  // The sniper is naturally scheduled AFTER the frame that creates his shot,
  // which is the whole problem. Nothing here is scripted; the only thing that
  // changes is the order.
  issue(state, "vale", ["kell", "veteran"]);
  const commandedOrder = queued(state, 2);
  Z.executeCommand(state, { type: "endTurn", unitId: vale.id });

  Z.runActivation(state);
  const kell = ref(state, "kell");
  const veteran = ref(state, "veteran");
  const target = ref(state, "target");
  Z.applyStatusTo(state, kell.id, "overwatching");
  kell.x = 4; kell.y = 8;
  target.x = 12; target.y = 8;
  veteran.x = 14; veteran.y = 8;
  const reactionsBefore = state.reactions.log.length;
  Z.forcePush(state, veteran.id, target.id, 1);
  Z.settleBattle(state);

  const nyxActs = arena(513);
  const nyxVale = stage(nyxActs, "vale", ["reyes", "nyx"]);
  issue(nyxActs, "vale", ["nyx", "reyes"]);
  Z.executeCommand(nyxActs, { type: "endTurn", unitId: nyxVale.id });
  Z.runActivation(nyxActs);

  return {
    naturalOrder,
    commandedOrder,
    kellFirst: commandedOrder[0] === "kell",
    reactionEngaged: state.reactions.log.length >= reactionsBefore,
    stall: live(state),
    movedToBackActed: activationsOf(nyxActs, ref(nyxActs, "nyx").id) === 1,
    nyxStall: live(nyxActs)
  };
})()`);
check("7. naturally the frame acts before the sniper", synergy.naturalOrder.join(",") === "veteran,kell", synergy.naturalOrder.join(","));
check("   the command puts the sniper first instead", synergy.kellFirst, synergy.commandedOrder.join(","));
check("   the reaction lifecycle runs unchanged inside the reordered window", synergy.reactionEngaged);
check("   and the battle stays valid", synergy.stall === null, synergy.stall);
check("   a unit moved to the front still takes exactly one turn", synergy.movedToBackActed);
check("   with the battle playable", synergy.nyxStall === null, synergy.nyxStall);

/* ---- 8. determinism and cost ---- */
console.log("\ndeterminism and cost");
const perf = await page.evaluate(`(() => {
  ${PRELUDE}
  const one = arena(514);
  const two = arena(514);
  Z.runBattle(one, 200);
  Z.runBattle(two, 200);

  const state = arena(515);
  const vale = stage(state, "vale", ["reyes", "veteran", "nyx", "kell"]);
  const runs = 2000;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    Z.sequencing.plan(state, vale.id, "battlePlan");
  }
  const perPlan = (performance.now() - started) / runs;

  const wanted = ids(state, ["kell", "reyes", "veteran", "nyx"]);
  const previewStart = performance.now();
  for (let index = 0; index < 500; index += 1) {
    Z.sequencing.preview(state, vale.id, "battlePlan", wanted);
  }
  const perPreview = (performance.now() - previewStart) / 500;

  return {
    identical: Z.serializeBattle(one) === Z.serializeBattle(two),
    perPlan,
    perPreview,
    units: state.unitOrder.length
  };
})()`);
console.log(
  "    plan: " + perf.perPlan.toFixed(4) + "ms · full preview: " + perf.perPreview.toFixed(4) +
    "ms · " + perf.units + " units"
);
check("8. two runs of the same seed are identical", perf.identical);
check("   planning a window is free", perf.perPlan < 1, perf.perPlan.toFixed(4) + "ms");
check("   and a repeated preview is too", perf.perPreview < 2, perf.perPreview.toFixed(4) + "ms");

/* ---- 9. the planning UI ---- */
console.log("\nthe panel");
const panel = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(516);
  const vale = stage(state, "vale", ["reyes", "veteran", "nyx", "kell", "blocker"]);

  // Through the real input reducer, exactly as a click would.
  let input = Z.input.create({ mode: "unitReady", selectedUnitId: vale.id, inspectedUnitId: vale.id });
  input = Z.input.dispatch(input, { type: "chooseAbility", abilityId: "battlePlan" }, state).input;
  const opened = input.mode;

  for (const name of ["kell", "reyes", "veteran", "nyx"]) {
    input = Z.input.dispatch(input, { type: "toggleOrderPick", unitId: ref(state, name).id }, state).input;
  }
  const picked = input.plannedOrder.map((id) => refOf(state, id));

  // Clicking a picked unit again removes it, and renumbers the rest.
  input = Z.input.dispatch(input, { type: "toggleOrderPick", unitId: ref(state, "reyes").id }, state).input;
  const afterRemove = input.plannedOrder.map((id) => refOf(state, id));
  input = Z.input.dispatch(input, { type: "toggleOrderPick", unitId: ref(state, "reyes").id }, state).input;
  const afterReadd = input.plannedOrder.map((id) => refOf(state, id));

  // The enemy is not pickable at all.
  const enemyAttempt = Z.input.dispatch(input, { type: "toggleOrderPick", unitId: ref(state, "blocker").id }, state);

  const panelModel = Z.input.panel(state, input);
  const confirmed = Z.input.dispatch(input, { type: "confirmOrder" }, state);
  for (const command of confirmed.commands) Z.executeCommand(state, command);

  return {
    opened,
    picked,
    afterRemove,
    afterReadd,
    enemyRefused: enemyAttempt.errors.length > 0,
    enemyReason: enemyAttempt.errors.join(" | "),
    panelKind: panelModel.kind,
    panelTitle: panelModel.title,
    confirmEnabled: (panelModel.actions.find((a) => a.id === "confirmOrder") || {}).enabled,
    resulting: panelModel.order.resultingOrder.map((id) => refOf(state, id)),
    commands: confirmed.commands.map((c) => c.type),
    finalOrder: queued(state, 4),
    stall: live(state)
  };
})()`);
check("9. choosing the command opens order planning", panel.opened === "planningOrder", panel.opened);
check("   picking builds a numbered sequence", panel.picked.join(",") === "kell,reyes,veteran,nyx", panel.picked.join(","));
check("   picking again removes and renumbers", panel.afterRemove.join(",") === "kell,veteran,nyx", panel.afterRemove.join(","));
check("   the enemy behind the window cannot be picked", panel.enemyRefused, panel.enemyReason);
check("   the panel renders as an order panel", panel.panelKind === "order");
check("   titled with the ability", panel.panelTitle === "Battle Plan", panel.panelTitle);
check("   with confirm enabled", panel.confirmEnabled === true);
check("   showing the resulting order", panel.resulting.join(",").includes(panel.afterReadd.join(",")), panel.resulting.join(","));
check("   confirming issues exactly one command", panel.commands.join(",") === "reorderActivations", panel.commands.join(","));
check("   and the timeline updates to match", panel.finalOrder.join(",") === panel.afterReadd.join(","), panel.finalOrder.join(","));
check("   with the battle playable", panel.stall === null, panel.stall);

/* ---- 10. the log ---- */
console.log("\nthe log");
const log = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(517);
  stage(state, "vale", ["reyes", "veteran", "kell"]);
  issue(state, "vale", ["kell", "reyes", "veteran"]);
  const entry = state.battleLog.filter((e) => e.type === "activationOrderChanged").pop();
  return {
    logged: !!entry,
    text: entry ? entry.text : "",
    previous: entry ? entry.data.previousOrder.map((id) => refOf(state, id)) : [],
    next: entry ? entry.data.order.map((id) => refOf(state, id)) : [],
    cost: entry ? entry.data.cost : null,
    filtered: Z.battleLogFilters.includes("orders")
  };
})()`);
check("10. the reorder is an event, and it is logged", log.logged, log.text);
check("    it records the order it replaced", log.previous.join(",") === "reyes,veteran,kell", log.previous.join(","));
check("    and the order it set", log.next.join(",") === "kell,reyes,veteran", log.next.join(","));
check("    with the resource it cost", log.cost && log.cost.commandPoints === 2, JSON.stringify(log.cost));
check("    and the log can be filtered to it", log.filtered);

/* ---- 11. the Studio ---- */
console.log("\nstudio");
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
await page.getByRole("button", { name: /battlePlan/ }).first().click();
await page.waitForTimeout(600);
check("11. the command opens in the Studio", /Battle Plan/i.test(await page.locator("body").innerText()));
await page.getByRole("button", { name: /^Command window$/ }).first().click();
await page.waitForTimeout(400);
const studioText = await page.locator("body").innerText();
for (const label of ["May sequence", "Reach ahead", "Most units sequenced", "Enemy activations"]) {
  check("    " + label + " is editable", new RegExp(label, "i").test(studioText));
}

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));

  const negativeReach = clone();
  negativeReach.abilities.battlePlan.activationWindow.lookahead = -1;

  const soloWindow = clone();
  soloWindow.abilities.battlePlan.activationWindow.maxUnits = 1;

  const badRelationship = clone();
  badRelationship.abilities.battlePlan.activationWindow.relationship = "frenemy";

  const badBarrier = clone();
  badBarrier.abilities.battlePlan.activationWindow.hostileBarrier = "teleport";

  const unknownCost = clone();
  unknownCost.abilities.battlePlan.costs = { moxie: 2 };

  const strayEffects = clone();
  strayEffects.abilities.battlePlan.effects = [{ type: "damage", formula: "physical", power: 10 }];

  return {
    clean: validate.validateGameplayData(registry.CANONICAL_GAMEPLAY).errors.length,
    negativeReach: validate.validateGameplayData(negativeReach).errors.some((m) => /no further than now/.test(m)),
    soloWindow: validate.validateGameplayData(soloWindow).errors.some((m) => /fewer than two/.test(m)),
    badRelationship: validate.validateGameplayData(badRelationship).errors.some((m) => /frenemy/.test(m)),
    badBarrier: validate.validateGameplayData(badBarrier).errors.some((m) => /teleport/.test(m)),
    unknownCost: validate.validateGameplayData(unknownCost).errors.some((m) => /moxie/.test(m)),
    strayEffects: validate.validateGameplayData(strayEffects).warnings.some((m) => /never run/.test(m)),
    runningCost: window.STATUS_ZERO.content.abilities.battlePlan.costs.commandPoints
  };
});
check("12. the shipped data validates", authoring.clean === 0, String(authoring.clean));
check("    a window that reaches nowhere is refused", authoring.negativeReach);
check("    a window of one is refused", authoring.soloWindow);
check("    an unknown relationship is refused", authoring.badRelationship);
check("    an unknown barrier mode is refused", authoring.badBarrier);
check("    an unknown cost resource is refused", authoring.unknownCost);
check("    stray effects on a command are warned about", authoring.strayEffects);
check("    while the running content is untouched", authoring.runningCost === 2);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("13. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
