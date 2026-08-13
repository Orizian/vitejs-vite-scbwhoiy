/* Browser acceptance for combat support and resource transfer.
 *
 * The unit suite proves the arithmetic. This drives the thing the phase is
 * actually about, through the real runtime in a real page: a finite rack of
 * charges becomes somebody else's stored thrust, somebody else's stored
 * charge, and the squad's coordination budget — and the totals still add up.
 *
 * The conservation checks are the point. "Nothing was created" is not
 * observable from a screenshot; it is observable from adding the balances up
 * before and after, so that is what these do.
 *
 *   npm run check:support
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
    Z.createBattle("file:fixture-support-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: true,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const pool = (state, name, resourceId) => (ref(state, name).resources || {})[resourceId] || null;
  const setPool = (state, name, resourceId, value) => {
    const entry = pool(state, name, resourceId);
    if (entry) entry.current = value;
    return entry;
  };
  const cp = (state) => Z.combatResources.faction(state, ref(state, "reyes").teamId).commandPoints;
  /* Activate first: her rack regenerates on activation, so any baseline read
   * before that is a different number than the one the ability sees. */
  const stage = (state) => {
    const reyes = ref(state, "reyes");
    Z.activateUnitForTest(state, reyes.id);
    return reyes;
  };
  const use = (state, abilityId, targetName) => {
    const reyes = ref(state, "reyes");
    return Z.executeCommand(state, {
      type: "useAbility",
      unitId: reyes.id,
      abilityId,
      target: { unitId: targetName ? ref(state, targetName).id : reyes.id }
    });
  };
  const live = (state) => {
    const next = Z.battleContinuation(state);
    return next.kind !== "stalled" ? null : next.kind + ": " + (next.reason || "");
  };
  const transfers = (state) =>
    state.battleLog.filter((entry) => entry.type === "resourceTransferred");
`;

/* ---- 1. the rack, and what it is for ---- */
console.log("the rack");
const rack = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(700);
  const reyes = stage(state);
  const charge = pool(state, "reyes", "supportCharge");
  const burst = pool(state, "veteran", "burst");
  const capacitor = pool(state, "arcSpecialist", "capacitor");
  return {
    hasRack: !!charge,
    rackMax: charge ? charge.max : null,
    veteranEconomy: !!burst,
    specialistEconomy: !!capacitor,
    differentEconomies: !!burst && !!capacitor,
    abilities: Z.content.units[reyes.definitionId].abilities,
    stall: live(state)
  };
})()`);
check("1. the support frame carries a finite rack", rack.hasRack && rack.rackMax > 0, String(rack.rackMax));
check("   the two allies run on different economies", rack.differentEconomies);
check("   and she keeps her welder", rack.abilities.includes("arcWelder"), rack.abilities.join(","));
check("   the battle has somewhere to go", rack.stall === null, rack.stall);

/* ---- 2. transfer, and conservation ---- */
console.log("\ntransfer");
const transfer = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(701);
  stage(state);
  setPool(state, "reyes", "supportCharge", 4);
  setPool(state, "veteran", "burst", 1);
  const before = pool(state, "reyes", "supportCharge").current + pool(state, "veteran", "burst").current;

  const result = use(state, "powerTransfer", "veteran");
  const charge = pool(state, "reyes", "supportCharge").current;
  const burst = pool(state, "veteran", "burst").current;
  const entry = transfers(state)[0];
  return {
    ok: result.ok,
    errors: result.errors || [],
    charge,
    burst,
    conserved: charge + burst === before,
    spent: entry ? entry.data.spent : null,
    gained: entry ? entry.data.gained : null,
    text: entry ? entry.text : "",
    stall: live(state)
  };
})()`);
check("2. the transfer runs", transfer.ok, transfer.errors.join("|"));
check("   she paid four down to two", transfer.charge === 2, String(transfer.charge));
check("   and one became three", transfer.burst === 3, String(transfer.burst));
check("   nothing was created", transfer.conserved);
check("   the log connects the two halves", transfer.spent === 2 && transfer.gained === 2, transfer.text);
check("   and the battle has somewhere to go", transfer.stall === null, transfer.stall);

/* ---- 3. the cap, and what it must not cost ---- */
console.log("\ncaps and refusals");
const caps = await page.evaluate(`(() => {
  ${PRELUDE}
  const partial = arena(702);
  stage(partial);
  setPool(partial, "reyes", "supportCharge", 4);
  const burst = pool(partial, "veteran", "burst");
  burst.current = burst.max - 1;
  const partialResult = use(partial, "powerTransfer", "veteran");

  const full = arena(703);
  stage(full);
  setPool(full, "reyes", "supportCharge", 4);
  const fullBurst = pool(full, "veteran", "burst");
  fullBurst.current = fullBurst.max;
  const fullResult = use(full, "powerTransfer", "veteran");
  const fullModel = Z.abilityModel(full, ref(full, "reyes").id, "powerTransfer");

  const broke = arena(704);
  stage(broke);
  setPool(broke, "reyes", "supportCharge", 0);
  setPool(broke, "veteran", "burst", 1);
  const brokeResult = use(broke, "powerTransfer", "veteran");

  return {
    partialOk: partialResult.ok,
    partialBurst: burst.current === burst.max,
    partialCharge: pool(partial, "reyes", "supportCharge").current,
    partialLimit: (transfers(partial)[0] || {}).data ? transfers(partial)[0].data.limitedBy : null,
    fullRefused: fullResult.ok === false,
    fullReason: (fullResult.errors || []).join(" | "),
    fullUnusable: fullModel.usable === false,
    fullUnusableReason: fullModel.unusableReason,
    fullChargeUntouched: pool(full, "reyes", "supportCharge").current === 4,
    brokeRefused: brokeResult.ok === false,
    brokeBurst: pool(broke, "veteran", "burst").current === 1
  };
})()`);
check("3. a partial transfer fills the room that exists", caps.partialOk && caps.partialBurst);
check("   and spends only what it delivered", caps.partialCharge === 3, String(caps.partialCharge));
check("   saying which end limited it", caps.partialLimit === "destination", caps.partialLimit);
check("   a full target is refused", caps.fullRefused, caps.fullReason);
check("   the button says so before it is pressed", caps.fullUnusable, caps.fullUnusableReason);
check("   and nothing was spent finding out", caps.fullChargeUntouched);
check("   an empty rack transfers nothing", caps.brokeRefused && caps.brokeBurst);

/* ---- 4. the same architecture, a different economy ---- */
console.log("\nthe second economy");
const second = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(705);
  stage(state);
  setPool(state, "reyes", "supportCharge", 4);
  setPool(state, "arcSpecialist", "capacitor", 0);
  const result = use(state, "coolantTransfer", "arcSpecialist");
  const power = Z.content.abilities.powerTransfer.effects[0];
  const coolant = Z.content.abilities.coolantTransfer.effects[0];
  return {
    ok: result.ok,
    errors: result.errors || [],
    charge: pool(state, "reyes", "supportCharge").current,
    capacitor: pool(state, "arcSpecialist", "capacitor").current,
    sameEffectType: power.type === coolant.type,
    differentData: power.intoResourceId !== coolant.intoResourceId,
    stall: live(state)
  };
})()`);
check("4. the same effect funds an entirely different resource", second.ok, second.errors.join("|"));
check("   two charges became four capacitor", second.charge === 2 && second.capacitor === 4, second.charge + " / " + second.capacitor);
check("   through one effect type", second.sameEffectType);
check("   with only the authored data differing", second.differentData);
check("   and the battle has somewhere to go", second.stall === null, second.stall);

/* ---- 5. crossing scope ---- */
console.log("\ncrossing scope");
const scope = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(706);
  stage(state);
  setPool(state, "reyes", "supportCharge", 4);
  cp(state).current = 1;
  const result = use(state, "tacticalRelay");
  const entry = transfers(state)[0];

  const capped = arena(707);
  stage(capped);
  setPool(capped, "reyes", "supportCharge", 4);
  cp(capped).current = cp(capped).max;
  const cappedResult = use(capped, "tacticalRelay");

  const odd = arena(708);
  stage(odd);
  setPool(odd, "reyes", "supportCharge", 1);
  cp(odd).current = 0;
  const oddResult = use(odd, "tacticalRelay");

  return {
    ok: result.ok,
    errors: result.errors || [],
    charge: pool(state, "reyes", "supportCharge").current,
    points: cp(state).current,
    spent: entry ? entry.data.spent : null,
    gained: entry ? entry.data.gained : null,
    scope: entry ? entry.data.toResourceId : null,
    cappedRefused: cappedResult.ok === false,
    cappedCharge: pool(capped, "reyes", "supportCharge").current === 4,
    oddRefused: oddResult.ok === false,
    oddCharge: pool(odd, "reyes", "supportCharge").current === 1,
    stall: live(state)
  };
})()`);
check("5. a personal resource becomes a squad one", scope.ok, scope.errors.join("|"));
check("   two of hers for one of the squad's", scope.spent === 2 && scope.gained === 1, scope.spent + " → " + scope.gained);
check("   landing in the shared pool", scope.scope === "commandPoints" && scope.points === 2, String(scope.points));
check("   a capped squad pool is not paid into", scope.cappedRefused && scope.cappedCharge);
check("   an all-or-nothing exchange does not half-happen", scope.oddRefused && scope.oddCharge);
check("   and the battle has somewhere to go", scope.stall === null, scope.stall);

/* ---- 6. the squad spends what she made ---- */
console.log("\nthe squad economy");
const economy = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(709);
  const reyes = stage(state);
  setPool(state, "reyes", "supportCharge", 4);
  cp(state).current = 1;

  const vale = ref(state, "vale");
  const beforePlan = Z.abilityModel(state, vale.id, "battlePlan");
  use(state, "tacticalRelay");
  Z.executeCommand(state, { type: "endTurn", unitId: reyes.id });

  // Stage the commander the ordinary way, then read the budget: activating
  // regenerates the shared pool, so an absolute taken earlier means nothing.
  Z.activateUnitForTest(state, vale.id);
  const queueBase = state.currentTime + 100;
  ["kell", "veteran", "arcSpecialist"].forEach((name, index) => {
    ref(state, name).nextActionTime = queueBase + index * 100;
  });
  const named = new Set(["kell", "veteran", "arcSpecialist"].map((n) => ref(state, n).id));
  named.add(vale.id);
  for (const id of state.unitOrder) {
    if (!named.has(id)) state.units[id].nextActionTime = queueBase + 100000;
  }

  const afterPlan = Z.abilityModel(state, vale.id, "battlePlan");
  const budget = cp(state).current;
  const naturalOrder = Z.sequencing.upcoming(state)
    .filter((id) => id !== state.activeUnitId)
    .slice(0, 3)
    .map((id) => state.units[id].ref);
  const commanded = Z.executeCommand(state, {
    type: "reorderActivations",
    unitId: vale.id,
    abilityId: "battlePlan",
    order: ["veteran", "kell", "arcSpecialist"].map((n) => ref(state, n).id)
  });
  const resultingOrder = Z.sequencing.upcoming(state)
    .filter((id) => id !== state.activeUnitId)
    .slice(0, 3)
    .map((id) => state.units[id].ref);

  return {
    unaffordableBefore: beforePlan.usable === false,
    reason: beforePlan.unusableReason,
    affordableAfter: afterPlan.usable === true,
    commanded: commanded.ok,
    errors: commanded.errors || [],
    spent: budget - cp(state).current,
    naturalOrder,
    resultingOrder,
    stall: live(state)
  };
})()`);
check("6. the plan was unaffordable before she acted", economy.unaffordableBefore, economy.reason);
check("   and affordable after", economy.affordableAfter);
check("   the command runs on the generated point", economy.commanded, economy.errors.join("|"));
check("   spending it like any other", economy.spent === 2, String(economy.spent));
check(
  "   and the order actually changed",
  economy.naturalOrder.join(",") !== economy.resultingOrder.join(","),
  economy.naturalOrder.join(",") + " → " + economy.resultingOrder.join(",")
);
check("   with the battle playable", economy.stall === null, economy.stall);

/* ---- 7. repair, hull and system ---- */
console.log("\nrepair");
const repair = await page.evaluate(`(() => {
  ${PRELUDE}
  const hull = arena(710);
  stage(hull);
  const hurt = ref(hull, "veteran");
  hurt.currentHp = 20;
  const hullResult = use(hull, "fieldRepair", "veteran");

  const system = arena(711);
  stage(system);
  const veteran = ref(system, "veteran");
  const routeBefore = Z.unitAbilities(system, veteran.id).includes("impactChain");
  Z.applyStatusTo(system, veteran.id, "thrustersImpaired");
  const routeOffline = !Z.unitAbilities(system, veteran.id).includes("impactChain");
  const why = Z.abilityImpairment(system, veteran.id, "impactChain");
  const rackBefore = pool(system, "reyes", "supportCharge").current;
  const repaired = use(system, "systemRepair", "veteran");
  const routeBack = Z.unitAbilities(system, veteran.id).includes("impactChain");

  const sensors = arena(712);
  stage(sensors);
  const specialist = ref(sensors, "arcSpecialist");
  Z.applyStatusTo(sensors, specialist.id, "sensorsImpaired");
  const sensorsHurt = specialist.statuses.some((s) => s.statusId === "sensorsImpaired");
  const sensorsFixed = use(sensors, "systemRepair", "arcSpecialist");

  return {
    hullOk: hullResult.ok,
    healed: hurt.currentHp > 20,
    withinMax: hurt.currentHp <= Z.content.units[hurt.definitionId].baseStats.maxHp + 200,
    routeBefore,
    routeOffline,
    offlineReason: why ? why.name : null,
    repairedOk: repaired.ok,
    routeBack,
    chargeSpent: rackBefore - pool(system, "reyes", "supportCharge").current,
    sensorsHurt,
    sensorsFixedOk: sensorsFixed.ok,
    sensorsClear: !ref(sensors, "arcSpecialist").statuses.some((s) => s.statusId === "sensorsImpaired"),
    stall: live(system)
  };
})()`);
check("7. hull repair runs through the ordinary pipeline", repair.hullOk && repair.healed && repair.withinMax);
check("   an impaired system takes the capability offline", repair.routeBefore && repair.routeOffline, repair.offlineReason);
check("   repair brings it back", repair.repairedOk && repair.routeBack);
check("   at the ordinary price of one charge", repair.chargeSpent === 1, String(repair.chargeSpent));
check("   a different impairment uses the same repair", repair.sensorsHurt && repair.sensorsFixedOk && repair.sensorsClear);
check("   and the battle has somewhere to go", repair.stall === null, repair.stall);

/* ---- 8. reacting, and fighting ---- */
console.log("\nout of turn, and up close");
const combat = await page.evaluate(`(() => {
  ${PRELUDE}
  const patch = arena(713);
  const reyes = stage(patch);
  Z.applyStatusTo(patch, reyes.id, "fieldReady");
  setPool(patch, "reyes", "supportCharge", 3);
  const veteran = ref(patch, "veteran");
  veteran.currentHp = 40;
  Z.missionEngine.scriptedAttack(patch, {
    sourceUnitId: ref(patch, "shooter").id,
    targetUnitIds: [veteran.id],
    power: 90,
    formula: "physical"
  });
  Z.settleBattle(patch);
  const fired = patch.reactions.log.filter((e) => e.ok).map((e) => e.reactionId);

  const welder = arena(714);
  stage(welder);
  const target = ref(welder, "target");
  const hpBefore = target.currentHp;
  const welderResult = use(welder, "arcWelder", "target");

  return {
    fired,
    patched: fired.includes("emergencyPatch"),
    ownRack: pool(patch, "reyes", "supportCharge").current === 2,
    patchStall: live(patch),
    welderOk: welderResult.ok,
    welderErrors: welderResult.errors || [],
    hurt: target.currentHp < hpBefore,
    welderStall: live(welder)
  };
})()`);
check("8. she can keep a frame standing out of turn", combat.patched, combat.fired.join(", ") || "nothing fired");
check("   out of her own rack, not the squad's", combat.ownRack);
check("   and the battle has somewhere to go", combat.patchStall === null, combat.patchStall);
check("   the welder is still a weapon", combat.welderOk && combat.hurt, combat.welderErrors.join("|"));
check("   with the battle playable", combat.welderStall === null, combat.welderStall);

/* ---- 9. preview parity ---- */
console.log("\npreview and execution agree");
const parity = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(715);
  const reyes = stage(state);
  setPool(state, "reyes", "supportCharge", 4);
  const burst = pool(state, "veteran", "burst");
  burst.current = burst.max - 1;

  const preview = Z.validateCommand(state, {
    type: "useAbility",
    unitId: reyes.id,
    abilityId: "powerTransfer",
    target: { unitId: ref(state, "veteran").id }
  }).preview;
  const forecast = (preview.outcomes || []).find((o) => o.effectType === "transferResource");
  use(state, "powerTransfer", "veteran");
  const actual = transfers(state)[0].data;
  return {
    forecast: forecast ? { spent: forecast.spent, gained: forecast.gained, label: forecast.display.value } : null,
    actual: { spent: actual.spent, gained: actual.gained }
  };
})()`);
check("9. the transfer is forecast at all", !!parity.forecast, parity.forecast ? parity.forecast.label : "");
check(
  "   the cap is in the promise, not a surprise",
  parity.forecast && parity.forecast.gained === 1,
  parity.forecast ? String(parity.forecast.gained) : ""
);
check(
  "   and execution matches it exactly",
  parity.forecast &&
    parity.forecast.spent === parity.actual.spent &&
    parity.forecast.gained === parity.actual.gained,
  JSON.stringify(parity)
);

/* ---- 10. persistence ---- */
console.log("\npersistence");
const saved = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(716);
  stage(state);
  setPool(state, "reyes", "supportCharge", 2);
  setPool(state, "veteran", "burst", 3);
  setPool(state, "arcSpecialist", "capacitor", 5);
  cp(state).current = 3;
  Z.applyStatusTo(state, ref(state, "veteran").id, "thrustersImpaired");

  const restored = Z.deserializeBattle(Z.serializeBattle(state));
  const before = {
    charge: pool(state, "reyes", "supportCharge").current,
    burst: pool(state, "veteran", "burst").current,
    capacitor: pool(state, "arcSpecialist", "capacitor").current,
    points: cp(state).current
  };
  const after = {
    charge: pool(restored, "reyes", "supportCharge").current,
    burst: pool(restored, "veteran", "burst").current,
    capacitor: pool(restored, "arcSpecialist", "capacitor").current,
    points: cp(restored).current
  };
  return {
    before,
    after,
    match: JSON.stringify(before) === JSON.stringify(after),
    stillImpaired: ref(restored, "veteran").statuses.some((s) => s.statusId === "thrustersImpaired"),
    stall: live(restored)
  };
})()`);
check("10. every altered balance survives a reload", saved.match, JSON.stringify(saved.before) + " vs " + JSON.stringify(saved.after));
check("    no pool regenerated on the way through", saved.after.charge === 2, String(saved.after.charge));
check("    and the frame is still missing what it was missing", saved.stillImpaired);
check("    with the battle playable", saved.stall === null, saved.stall);

/* ---- 11. cost ---- */
console.log("\ncost");
const perf = await page.evaluate(`(() => {
  ${PRELUDE}
  const one = arena(717);
  const two = arena(717);
  Z.runBattle(one, 200);
  Z.runBattle(two, 200);

  const state = arena(718);
  const reyes = stage(state);
  const runs = 3000;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    Z.abilityModel(state, reyes.id, "powerTransfer");
  }
  const per = (performance.now() - started) / runs;
  return { identical: Z.serializeBattle(one) === Z.serializeBattle(two), per };
})()`);
console.log("    ability model incl. transfer plan: " + perf.per.toFixed(4) + "ms");
check("11. two runs of the same seed are identical", perf.identical);
check("    and asking what a transfer would do is free", perf.per < 2, perf.per.toFixed(4) + "ms");


/* ---- 15. the tactical language ----
 *
 * The connective vocabulary, driven through the real runtime: an ability
 * refused on a balance, a mark that changes a number the player is shown and
 * then delivers it, and a status acting at a moment other than the start of a
 * turn. Everything below is authored data; none of it has engine support for
 * the particular resource, status or pilot involved.
 */
console.log("\ntactical language");

const language = await page.evaluate(`(() => {
  ${PRELUDE}

  /* -- a balance decides whether an ability is offered at all -- */
  const gate = arena(940);
  const veteran = ref(gate, "veteran");
  Z.activateUnitForTest(gate, veteran.id);
  setPool(gate, "veteran", "burst", 5);
  const whenFull = Z.abilityModel(gate, veteran.id, "spoolDrive");
  setPool(gate, "veteran", "burst", 2);
  const whenRoom = Z.abilityModel(gate, veteran.id, "spoolDrive");

  /* -- the same condition shape, asked of the squad's shared pool -- */
  const shared = arena(941);
  const reyes = stage(shared);
  setPool(shared, "reyes", "supportCharge", 4);
  const budget = cp(shared);
  budget.current = budget.max;
  const relayFull = Z.abilityModel(shared, reyes.id, "tacticalRelay");
  budget.current = 1;
  const relayRoom = Z.abilityModel(shared, reyes.id, "tacticalRelay");

  /* -- a mark is worth a number, and the number is kept -- */
  const marked = arena(942);
  const kell = ref(marked, "kell");
  const victim = ref(marked, "target");
  kell.x = victim.x - 4;
  kell.y = victim.y;
  const shot = (state, shooter, mark) =>
    Z.forecastAbility(state, shooter.id, "precisionShot", mark.id)
      .filter((entry) => entry.effectType === "damage")
      .reduce((total, entry) => total + entry.amount, 0);

  const beforeMark = shot(marked, kell, victim);
  Z.reactionEngine.applyStatus(marked, kell.id, [victim.id], "marked");
  Z.reactionEngine.applyStatus(marked, kell.id, [kell.id], "braced");
  Z.settleBattle(marked);
  const afterMark = shot(marked, kell, victim);

  Z.activateUnitForTest(marked, kell.id);
  const fired = Z.executeCommand(marked, {
    type: "useAbility",
    unitId: kell.id,
    abilityId: "precisionShot",
    target: { unitId: victim.id }
  });
  const landed = fired.events.find((event) => event.type === "damageResolved");
  const missed = fired.events.some((event) => event.type === "attackMissed");

  /* -- a status acting when the activation ends -- */
  const closing = arena(943);
  const cooler = ref(closing, "veteran");
  cooler.statuses.push({ statusId: "coolingCycle", remaining: 3 });
  Z.activateUnitForTest(closing, cooler.id);
  Z.settleBattle(closing);
  setPool(closing, "veteran", "burst", 0);
  Z.executeCommand(closing, { type: "endTurn", unitId: cooler.id });
  Z.settleBattle(closing);

  /* -- a status answering whoever damaged it, and stopping -- */
  const plated = arena(944);
  const wearer = ref(plated, "veteran");
  const attacker = ref(plated, "target");
  wearer.currentHp = 99999;
  attacker.currentHp = 99999;
  wearer.statuses.push({ statusId: "reactivePlating", remaining: 99 });
  attacker.statuses.push({ statusId: "reactivePlating", remaining: 99 });
  Z.activateUnitForTest(plated, attacker.id);
  const exchange = Z.executeCommand(plated, {
    type: "useAbility",
    unitId: attacker.id,
    abilityId: "handCannon",
    target: { unitId: wearer.id }
  });
  Z.settleBattle(plated);
  const exchanges = (exchange.events || []).filter(
    (event) => event.type === "statusTriggered"
  ).length;
  const opened = (exchange.events || []).some((event) => event.type === "damageResolved");

  return {
    fullRefused: whenFull.usable === false,
    fullReason: (whenFull.unusableReasons || []).join(" "),
    roomOffered: whenRoom.usable === true,
    relayFullRefused: relayFull.usable === false,
    relayRoomOffered: relayRoom.usable === true,
    sameConditionType:
      Z.content.abilities.spoolDrive.conditions[0].type ===
      Z.content.abilities.tacticalRelay.conditions[0].type,
    beforeMark,
    afterMark,
    landedAmount: landed ? landed.amount : null,
    landedMultiplier: landed ? landed.scalingMultiplier : null,
    missed,
    coolingRestored: (pool(closing, "veteran", "burst") || {}).current,
    exchanges,
    opened,
    queueDrained: plated.resolutionQueue.length === 0,
    noRunaway: !(plated.errors || []).some((message) => /maximum event count/.test(message)),
    stillStanding: wearer.alive && attacker.alive
  };
})()`);

check("15. a full rack refuses the ability that fills it", language.fullRefused);
check("    and says why", /room/i.test(language.fullReason), language.fullReason);
check("    while a rack with room offers it", language.roomOffered);
check("    the same condition shape gates on the squad's pool", language.relayFullRefused);
check("    which opens again when the pool has room", language.relayRoomOffered);
check("    one condition type covers both scopes", language.sameConditionType);
check(
  "16. a mark raises the number the player is shown",
  language.afterMark > language.beforeMark,
  language.beforeMark + " → " + language.afterMark
);
check(
  "    and the shot delivers exactly what was promised",
  language.missed || language.landedAmount === language.afterMark,
  language.missed ? "missed" : language.landedAmount + " vs " + language.afterMark
);
check(
  "    with the mark attributed rather than baked in",
  language.missed || language.landedMultiplier > 1,
  String(language.landedMultiplier)
);
check(
  "17. a status acts when the activation closes",
  language.coolingRestored === 1,
  String(language.coolingRestored)
);
check(
  "18. retaliation answering retaliation goes back and forth",
  !language.opened || language.exchanges > 1,
  language.exchanges + " steps"
);
check("    and stops on its own", language.queueDrained && language.noRunaway);
check("    with both frames still standing", language.stillStanding);

/* ---- 12. the Studio ---- */
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
await page.getByRole("button", { name: /powerTransfer/ }).first().click();
await page.waitForTimeout(600);
check("12. the transfer ability opens in the Studio", /Power Transfer/i.test(await page.locator("body").innerText()));
await page.getByRole("button", { name: /^Statuses$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /thrustersImpaired/ }).first().click();
await page.waitForTimeout(600);
const statusText = await page.locator("body").innerText();
check("    the impairment opens too", /Thrusters Impaired/i.test(statusText));
await page.getByRole("button", { name: /^Engine behaviour$/ }).first().click();
await page.waitForTimeout(400);
const behaviourText = await page.locator("body").innerText();
check("    taking abilities offline is editable", /Takes these offline/i.test(behaviourText));
check("    and so is doing it by tag", /Takes tagged actions offline/i.test(behaviourText));
// The moments a status may act on are offered as a closed list, and the list
// is the engine's own — an author cannot type a moment nothing fires.
check(
  "    the trigger moments are offered as a closed list",
  /activationStart/.test(behaviourText) &&
    /activationEnd/.test(behaviourText) &&
    /unitDamaged/.test(behaviourText) &&
    /killedUnit/.test(behaviourText)
);
check("    including where a trigger lands", /counterpart/i.test(behaviourText));

await page.getByRole("button", { name: /^Operators$/ }).first().click();
await page.waitForTimeout(700);
const operatorList = await page.locator("body").innerText();
check("    operators are listed by canonical id", /\bvale\b/.test(operatorList));
await page.getByRole("button", { name: /Commander Vale/ }).first().click();
await page.waitForTimeout(600);
const operatorText = await page.locator("body").innerText();
check("    the pilot opens under that id", /Commander Vale/i.test(operatorText));
check(
  "    and carries no second name to drift from it",
  !/Stable content ref/i.test(operatorText)
);

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));

  const unknownSource = clone();
  unknownSource.abilities.powerTransfer.effects[0].resourceId = "nonsense";

  const unknownDestination = clone();
  unknownDestination.abilities.powerTransfer.effects[0].intoResourceId = "alsoNonsense";

  const negative = clone();
  negative.abilities.powerTransfer.effects[0].cost = -2;

  const pointless = clone();
  pointless.abilities.powerTransfer.effects[0].intoResourceId = "supportCharge";
  pointless.abilities.powerTransfer.effects[0].to = "source";

  const overDeliver = clone();
  overDeliver.abilities.powerTransfer.effects[0].gain = 999;

  const danglingAbility = clone();
  danglingAbility.statuses.thrustersImpaired.removesAbilities = ["noSuchAbility"];

  const danglingTag = clone();
  danglingTag.statuses.thrustersImpaired.blocksAbilityTags = ["nothingHasThisTag"];

  return {
    clean: validate.validateGameplayData(registry.CANONICAL_GAMEPLAY).errors.length,
    unknownSource: validate.validateGameplayData(unknownSource).errors.some((m) => /nonsense/.test(m)),
    unknownDestination: validate.validateGameplayData(unknownDestination).errors.some((m) => /alsoNonsense/.test(m)),
    negative: validate.validateGameplayData(negative).errors.some((m) => /positive whole cost/.test(m)),
    pointless: validate.validateGameplayData(pointless).errors.some((m) => /came from/.test(m)),
    overDeliver: validate.validateGameplayData(overDeliver).errors.some((m) => /can ever hold/.test(m)),
    danglingAbility: validate.validateGameplayData(danglingAbility).errors.some((m) => /noSuchAbility/.test(m)),
    danglingTag: validate.validateGameplayData(danglingTag).errors.some((m) => /nothingHasThisTag/.test(m)),
    runningCost: window.STATUS_ZERO.content.abilities.tacticalRelay.effects[0].cost
  };
});
check("13. the shipped data validates", authoring.clean === 0, String(authoring.clean));
check("    an unknown source resource is refused", authoring.unknownSource);
check("    an unknown destination resource is refused", authoring.unknownDestination);
check("    a negative cost is refused", authoring.negative);
check("    a transfer into its own balance is refused", authoring.pointless);
check("    delivering more than a pool can hold is refused", authoring.overDeliver);
check("    an impairment naming a missing ability is refused", authoring.danglingAbility);
check("    and one blocking a tag nothing carries is refused", authoring.danglingTag);
check("    while the running content is untouched", authoring.runningCost === 2);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("14. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
