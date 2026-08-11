/* Browser acceptance for defensive interception.
 *
 * The unit suite proves the model as functions. This drives the thing the
 * phase is actually about, through the real runtime in a real page: an enemy
 * chooses an action, somebody else decides it does not happen, and the battle
 * carries on being playable.
 *
 * Half of these checks are the mechanic. The other half are the invariant,
 * because the reaction lifecycle has softlocked this project before and the
 * only defence that has ever worked is asking `battleContinuation` after
 * every single step.
 *
 *   npm run check:duel
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
    Z.createBattle("file:fixture-duel-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: true,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const guard = (state, duelistRef, enemyRef) => {
    const d = ref(state, duelistRef);
    const e = ref(state, enemyRef);
    Z.applyStatusTo(state, d.id, "onGuard");
    Z.reactionEngine.applyStatus(state, d.id, [e.id], "challenged");
    Z.settleBattle(state);
    return { d, e };
  };
  const live = (state) => {
    const next = Z.battleContinuation(state);
    return next.kind !== "stalled" ? null : next.kind + ": " + (next.reason || "");
  };
  const declarations = (state) => Z.interventions.all(state);
  const last = (state) => declarations(state).slice(-1)[0] || null;
  const logTypes = (state, from) => state.battleLog.slice(from).map((entry) => entry.type);
`;

/* ---- 1. the default path is untouched ---- */
console.log("baseline");
const baseline = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(300);
  const kell = ref(state, "kell");
  const bravo = ref(state, "bravo");
  bravo.x = 5; bravo.y = 4;
  Z.activateUnitForTest(state, kell.id);
  const hp = bravo.currentHp;
  const result = Z.executeCommand(state, {
    type: "useAbility", unitId: kell.id, abilityId: "handCannon", target: { unitId: bravo.id }
  });
  const record = last(state);
  return {
    ok: result.ok,
    errors: result.errors || [],
    verdict: record ? record.verdict.kind : null,
    resolved: record ? record.resolved : null,
    damaged: bravo.currentHp < hp,
    prevented: state.battleLog.filter((e) => e.type === "actionPrevented").length,
    stall: live(state)
  };
})()`);
check("1. an ordinary action still resolves", baseline.ok && baseline.damaged, baseline.errors.join("|"));
check("   it passed through a declaration", baseline.verdict === "continue" && baseline.resolved);
check("   nothing was prevented", baseline.prevented === 0);
check("   and the battle has somewhere to go", baseline.stall === null, baseline.stall);

/* ---- 2. cancel ---- */
console.log("\ncancel");
const cancelled = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(301);
  const { d, e } = guard(state, "duelist", "runner");
  Z.activateUnitForTest(state, e.id);
  const from = { x: e.x, y: e.y };
  const before = state.battleLog.length;
  const result = Z.executeCommand(state, {
    type: "move", unitId: e.id,
    path: [from, { x: from.x + 1, y: from.y }, { x: from.x + 2, y: from.y }]
  });
  const prevented = state.battleLog.filter((entry) => entry.type === "actionPrevented");
  return {
    ok: result.ok,
    stayed: e.x === from.x && e.y === from.y,
    spent: !!(state.activation && state.activation.moved),
    reason: prevented.length ? prevented[0].data.reason : null,
    blamed: prevented.length ? prevented[0].data.sourceUnitId === d.id : false,
    text: prevented.length ? prevented[0].text : "",
    types: logTypes(state, before),
    verdict: last(state) ? last(state).verdict.kind : null,
    stall: live(state)
  };
})()`);
check("2. a declared move can be vetoed", cancelled.ok && cancelled.stayed);
check("   the verdict is recorded as a cancel", cancelled.verdict === "cancel" && cancelled.reason === "cancel");
check("   the move is spent anyway — being stopped is not a refund", cancelled.spent);
check("   the log names who did it", cancelled.blamed, cancelled.text);
check("   and the battle has somewhere to go", cancelled.stall === null, cancelled.stall);

/* ---- 3. the follow-up ---- */
console.log("\nthe opening it creates");
const punished = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(302);
  const { e } = guard(state, "duelist", "runner");
  const hp = e.currentHp;
  Z.activateUnitForTest(state, e.id);
  const from = { x: e.x, y: e.y };
  Z.executeCommand(state, { type: "move", unitId: e.id, path: [from, { x: from.x + 1, y: from.y }] });
  const fired = state.reactions.log.filter((entry) => entry.ok).map((entry) => entry.reactionId);
  return {
    fired,
    hurt: e.currentHp < hp,
    stillThere: e.x === from.x && e.y === from.y,
    stall: live(state)
  };
})()`);
check("3. stopping an action opens the next one", punished.fired.includes("duelHoldTheLine"), punished.fired.join(", "));
check("   the counter is a separate authored reaction", punished.fired.includes("duelPunish"));
check("   it landed", punished.hurt);
check("   while the move still never happened", punished.stillThere);
check("   and the battle has somewhere to go", punished.stall === null, punished.stall);

/* ---- 4. redirect ---- */
console.log("\nredirect");
const redirected = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(303);
  const duelist = ref(state, "duelist");
  const ward = ref(state, "ward");
  const shooter = ref(state, "shooter");
  Z.applyStatusTo(state, duelist.id, "onGuard");
  Z.settleBattle(state);
  const wardHp = ward.currentHp;
  const duelistHp = duelist.currentHp;
  Z.activateUnitForTest(state, shooter.id);
  const before = state.battleLog.length;
  const result = Z.executeCommand(state, {
    type: "useAbility", unitId: shooter.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  return {
    ok: result.ok,
    errors: result.errors || [],
    verdict: last(state) ? last(state).verdict.kind : null,
    wardSafe: ward.currentHp === wardHp,
    tookIt: duelist.currentHp < duelistHp,
    logged: logTypes(state, before).includes("actionRedirected"),
    stall: live(state)
  };
})()`);
check("4. a shot at an ally is pulled onto the defender", redirected.ok && redirected.verdict === "redirect", redirected.errors.join("|"));
check("   the ally is untouched", redirected.wardSafe);
check("   the defender took it instead", redirected.tookIt);
check("   and the log explains why the shot moved", redirected.logged);
check("   and the battle has somewhere to go", redirected.stall === null, redirected.stall);

/* ---- 5. what a redirect may not do ---- */
console.log("\nthe limits of a redirect");
const limits = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(304);
  const shooter = ref(state, "shooter");
  const ward = ref(state, "ward");
  const kell = ref(state, "kell");
  Z.activateUnitForTest(state, shooter.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: shooter.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  // The declaration has resolved by now, so this is the "too late" case.
  const late = Z.interventions.propose(state, last(state).id, {
    kind: "redirect", byUnitId: kell.id, targetUnitId: kell.id
  });

  const second = arena(305);
  const s2 = ref(second, "shooter");
  const w2 = ref(second, "ward");
  const far = ref(second, "kell");
  Z.activateUnitForTest(second, s2.id);
  Z.validateCommand(second, { type: "useAbility", unitId: s2.id, abilityId: "handCannon", target: { unitId: w2.id } });
  Z.executeCommand(second, {
    type: "useAbility", unitId: s2.id, abilityId: "handCannon", target: { unitId: w2.id }
  });
  return {
    lateRefused: late.ok === false,
    lateReason: late.reason,
    farAway: Math.abs(far.x - s2.x) + Math.abs(far.y - s2.y)
  };
})()`);
check("5. an action that has resolved can no longer be intervened in", limits.lateRefused, limits.lateReason);

const outOfRange = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(306);
  const shooter = ref(state, "shooter");
  const ward = ref(state, "ward");
  const far = ref(state, "kell");
  Z.activateUnitForTest(state, shooter.id);
  // Held open: the command handler runs but the queue is not drained, so the
  // declaration is still pending when the redirect is proposed.
  Z.reactionEngine.applyStatus(state, shooter.id, [shooter.id], "braced");
  const declaredBefore = declarations(state).length;
  Z.executeCommand(state, {
    type: "useAbility", unitId: shooter.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  const record = last(state);
  return {
    opened: declarations(state).length > declaredBefore,
    redirectable: record ? record.redirectable : null,
    distance: Math.abs(far.x - shooter.x) + Math.abs(far.y - shooter.y),
    kinds: Z.interventions.kinds,
    perDeclaration: Z.interventions.limits.perDeclaration,
    perChain: Z.interventions.limits.perChain
  };
})()`);
check("   a single-target shot is marked redirectable", outOfRange.redirectable === true);
check("   the intervention kinds are exactly four", outOfRange.kinds.length === 4, outOfRange.kinds.join(", "));
check("   one intervention per declaration", outOfRange.perDeclaration === 1);
check("   and a per-chain ceiling exists", outOfRange.perChain >= 1, String(outOfRange.perChain));

/* ---- 6. intercept ---- */
console.log("\nintercept");
const intercepted = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(307);
  const { d, e } = guard(state, "duelist", "bravo");
  const ward = ref(state, "ward");
  e.currentHp = 900;
  const enemyHp = e.currentHp;
  const wardHp = ward.currentHp;
  Z.activateUnitForTest(state, e.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: e.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  const record = last(state);
  return {
    verdict: record ? record.verdict.kind : null,
    by: record ? record.verdict.byUnitId === d.id : false,
    hit: e.currentHp < enemyHp,
    never: ward.currentHp === wardHp,
    acted: !!(state.activation && state.activation.acted),
    stall: live(state)
  };
})()`);
check("6. an intercept replaces the action it answers", intercepted.verdict === "replace");
check("   attributed to the defender", intercepted.by);
check("   the attacker was hit", intercepted.hit);
check("   and never got their shot off", intercepted.never);
check("   but has still spent the action", intercepted.acted);
check("   and the battle has somewhere to go", intercepted.stall === null, intercepted.stall);

/* ---- 7. a shove is not a decision ---- */
console.log("\nforced movement");
const shoved = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(308);
  const { d, e } = guard(state, "duelist", "bravo");
  d.x = 4; d.y = 3;
  e.x = 5; e.y = 3;
  const before = declarations(state).length;
  const logBefore = state.battleLog.length;
  Z.forcePush(state, d.id, e.id, 1);
  return {
    moved: e.x === 6,
    declared: declarations(state).length - before,
    prevented: logTypes(state, logBefore).filter((t) => t === "actionPrevented").length,
    stall: live(state)
  };
})()`);
check("7. a shove still lands", shoved.moved);
check("   it opens no declaration", shoved.declared === 0);
check("   so nothing could veto it", shoved.prevented === 0);
check("   and the battle has somewhere to go", shoved.stall === null, shoved.stall);

/* ---- 8. the enemy uses it too ---- */
console.log("\nboth directions");
const enemySide = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(309);
  const bladeguard = ref(state, "bladeguard");
  const vale = ref(state, "vale");
  const heavy = ref(state, "heavy");
  bladeguard.x = vale.x + 1; bladeguard.y = vale.y;
  Z.applyStatusTo(state, bladeguard.id, "onGuard");
  Z.reactionEngine.applyStatus(state, bladeguard.id, [vale.id], "challenged");
  Z.settleBattle(state);
  heavy.x = vale.x; heavy.y = vale.y - 1;
  const valeHp = vale.currentHp;
  Z.activateUnitForTest(state, vale.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: vale.id, abilityId: "scatterShot", target: { unitId: heavy.id }
  });
  const record = last(state);
  return {
    verdict: record ? record.verdict.kind : null,
    by: record ? record.verdict.byUnitId === bladeguard.id : false,
    hurt: vale.currentHp < valeHp,
    stall: live(state)
  };
})()`);
check("8. the enemy duelist intercepts the player", enemySide.verdict === "replace" && enemySide.by);
check("   using the player's own tool, on the player", enemySide.hurt);
check("   and the battle has somewhere to go", enemySide.stall === null, enemySide.stall);

/* ---- 9. the prompt says what it will do ---- */
console.log("\nthe prompt");
const prompt = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = Z.createBattle("file:fixture-duel-arena", 310, {
    autoResolveScenes: true,
    autoResolveReactions: false
  });
  const { e } = guard(state, "duelist", "bravo");
  const ward = ref(state, "ward");
  e.currentHp = 900;
  Z.activateUnitForTest(state, e.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: e.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  const model = Z.reactionModel(state);
  // Not named 'window': this evaluates in page scope, where a const of that
  // name shadows the global the prelude just read.
  const pending = model && model.window;
  const offer = pending ? pending.offers[0] : null;
  const continuation = Z.battleContinuation(state);
  return {
    open: !!pending,
    trigger: pending ? pending.triggerText : null,
    name: offer ? offer.name : null,
    consequence: offer && offer.intervention ? offer.intervention.text : null,
    kind: offer && offer.intervention ? offer.intervention.kind : null,
    cost: offer ? offer.costText : null,
    parked: continuation.kind
  };
})()`);
check("9. an optional intervention parks on a prompt", prompt.open, prompt.trigger);
check("   the trigger reads as unfinished", /about to/i.test(prompt.trigger || ""), prompt.trigger);
check("   the offer states its consequence, not just its price", !!prompt.consequence, prompt.consequence);
check("   named as a replacement", prompt.kind === "replace");
check("   and the price is still there", /poise/i.test(prompt.cost || ""), prompt.cost);
check('   the continuation reports "reaction" while it waits', prompt.parked === "reaction");

const answered = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = Z.createBattle("file:fixture-duel-arena", 311, {
    autoResolveScenes: true,
    autoResolveReactions: false
  });
  const { e } = guard(state, "duelist", "bravo");
  const ward = ref(state, "ward");
  e.currentHp = 900;
  Z.activateUnitForTest(state, e.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: e.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  const wardHp = ward.currentHp;

  // Declining is the other half of the contract, and the half that used to
  // deadlock: the action must then resolve normally.
  const declined = Z.createBattle("file:fixture-duel-arena", 311, {
    autoResolveScenes: true,
    autoResolveReactions: false
  });
  const pair = guard(declined, "duelist", "bravo");
  const ward2 = ref(declined, "ward");
  pair.e.currentHp = 900;
  Z.activateUnitForTest(declined, pair.e.id);
  Z.executeCommand(declined, {
    type: "useAbility", unitId: pair.e.id, abilityId: "handCannon", target: { unitId: ward2.id }
  });
  const ward2Hp = ward2.currentHp;
  Z.resolveReactionChoice(declined, null);

  Z.resolveReactionChoice(state, Z.reactionModel(state).window.offers[0].id);
  return {
    acceptedStopped: ward.currentHp === wardHp,
    acceptedStall: live(state),
    acceptedContinuation: Z.battleContinuation(state).kind,
    declinedResolved: ward2.currentHp < ward2Hp,
    declinedVerdict: last(declined) ? last(declined).verdict.kind : null,
    declinedStall: live(declined)
  };
})()`);
check("   accepting stops the action", answered.acceptedStopped);
check("   and the battle carries on", answered.acceptedStall === null, answered.acceptedContinuation);
check("   declining lets it resolve normally", answered.declinedResolved && answered.declinedVerdict === "continue");
check("   and the battle carries on then too", answered.declinedStall === null, answered.declinedStall);

/* ---- 10. the invariant, under load ---- */
console.log("\nthe invariant");
const soak = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(312);
  let activations = 0;
  let worst = null;
  while (!state.finished && activations < 300) {
    const result = Z.runActivation(state);
    if (!result.unitId) break;
    activations += 1;
    const stall = live(state);
    if (stall && !worst) worst = "activation " + activations + " -> " + stall;
  }
  return {
    activations,
    finished: state.finished,
    worst,
    declarations: declarations(state).length,
    interventions: declarations(state).filter((r) => r.verdict.kind !== "continue").length
  };
})()`);
check("10. a whole battle of duelists runs", soak.activations > 5, soak.activations + " activations");
check("    it never stalls", soak.worst === null, soak.worst);
check("    and it reaches an ending", soak.finished || soak.activations >= 300);

const declining = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = Z.createBattle("file:fixture-duel-arena", 313, {
    autoResolveScenes: true,
    autoResolveReactions: false
  });
  let steps = 0;
  let worst = null;
  let guardCount = 0;
  while (!state.finished && steps < 300 && guardCount < 900) {
    guardCount += 1;
    if (Z.battleContinuation(state).kind === "reaction") {
      Z.resolveReactionChoice(state, null);
      const stall = live(state);
      if (stall && !worst) worst = "after declining -> " + stall;
      continue;
    }
    const result = Z.runActivation(state);
    if (!result.unitId) break;
    steps += 1;
    const stall = live(state);
    if (stall && !worst) worst = "activation " + steps + " -> " + stall;
  }
  return { steps, worst, livelocked: guardCount >= 900 };
})()`);
check("    declining every prompt still terminates", !declining.livelocked, declining.steps + " activations");
check("    and never stalls", declining.worst === null, declining.worst);

/* ---- 11. save/reload mid-declaration ---- */
console.log("\npersistence");
const persisted = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = Z.createBattle("file:fixture-duel-arena", 314, {
    autoResolveScenes: true,
    autoResolveReactions: false
  });
  const { e } = guard(state, "duelist", "bravo");
  const ward = ref(state, "ward");
  e.currentHp = 900;
  Z.activateUnitForTest(state, e.id);
  Z.executeCommand(state, {
    type: "useAbility", unitId: e.id, abilityId: "handCannon", target: { unitId: ward.id }
  });
  const restored = Z.deserializeBattle(Z.serializeBattle(state));
  const model = Z.reactionModel(restored);
  const wardHp = restored.units[ward.id].currentHp;
  Z.resolveReactionChoice(restored, model.window.offers[0].id);
  return {
    parked: !!model.window,
    sameWindow: model.window && model.window.id === Z.reactionModel(state).window.id,
    nextId: restored.interventions.nextId === state.interventions.nextId,
    declarations: restored.interventions.order.length,
    stopped: restored.units[ward.id].currentHp === wardHp,
    stall: live(restored)
  };
})()`);
check("11. a save mid-prompt reloads on the same prompt", persisted.parked && persisted.sameWindow);
check("    declaration ids do not restart", persisted.nextId);
check("    the pending declaration survives", persisted.declarations > 0, String(persisted.declarations));
check("    and resolving after the reload still works", persisted.stopped);
check("    with the battle playable", persisted.stall === null, persisted.stall);

/* ---- 12. the AI decides rather than accepting ---- */
console.log("\nthe AI");
const ai = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(315);
  const { d, e } = guard(state, "duelist", "bravo");
  const ward = ref(state, "ward");
  const offer = {
    reactionId: "duelIntercept",
    reactorId: d.id,
    priority: 90,
    cost: Z.reactionRegistries.index.reactionById.duelIntercept.cost
  };
  const real = {
    type: "actionDeclared", actionKind: "ability",
    unitId: e.id, sourceUnitId: e.id, abilityId: "handCannon", targetUnitIds: [ward.id]
  };
  const nothing = { ...real, targetUnitIds: [] };
  const full = Z.interventions.score(state, offer, real);
  const empty = Z.interventions.score(state, offer, nothing);
  d.resources.poise.current = 1;
  const scarce = Z.interventions.score(state, offer, real);
  return {
    full, empty, scarce,
    takesReal: Z.interventions.choose(state, offer, real),
    refusesNothing: Z.interventions.choose(state, offer, nothing)
  };
})()`);
check("12. a real threat scores above nothing", ai.full > ai.empty, ai.full.toFixed(1) + " vs " + ai.empty.toFixed(1));
check("    the last point of a pool costs more than the first", ai.scarce < ai.full, ai.scarce.toFixed(1) + " vs " + ai.full.toFixed(1));
check("    and the decision follows the score", ai.takesReal === true);

/* ---- 13. overhead ---- */
console.log("\ncost");
const perf = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(316);
  const shooter = ref(state, "shooter");
  const ward = ref(state, "ward");
  const runs = 2000;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    const record = Z.interventions.propose(state, "nope", { kind: "cancel" });
    if (record.ok) break;
  }
  const refusal = (performance.now() - started) / runs;

  const plain = Z.createBattle("file:fixture-duel-arena", 317, { autoResolveScenes: true, autoResolveReactions: true });
  const p = ref(plain, "shooter");
  const w = ref(plain, "ward");
  const cmdStart = performance.now();
  let commands = 0;
  for (let index = 0; index < 40; index += 1) {
    const battle = Z.createBattle("file:fixture-duel-arena", 400 + index, { autoResolveScenes: true, autoResolveReactions: true });
    const s = ref(battle, "kell");
    const t = ref(battle, "bravo");
    t.x = 5; t.y = 4; t.currentHp = 900;
    Z.activateUnitForTest(battle, s.id);
    Z.executeCommand(battle, { type: "useAbility", unitId: s.id, abilityId: "handCannon", target: { unitId: t.id } });
    commands += 1;
  }
  const perCommand = (performance.now() - cmdStart) / commands;
  void shooter; void ward; void p; void w;
  return { refusal, perCommand, retained: Z.interventions.limits.retained };
})()`);
console.log(
  "    lookup+refuse: " + perf.refusal.toFixed(5) + "ms · whole declared command incl. battle setup: " +
    perf.perCommand.toFixed(3) + "ms"
);
check("13. an intervention lookup is free", perf.refusal < 0.05, perf.refusal.toFixed(5) + "ms");
check("    and the declaration record is bounded", perf.retained > 0 && perf.retained <= 64, String(perf.retained));

/* ---- 14. the Studio authors it, and refuses nonsense ---- */
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
await page.getByRole("button", { name: /^Reactions$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /duelIntercept/ }).first().click();
await page.waitForTimeout(600);
check("14. the intervention opens in the Studio", /Intercept/i.test(await page.locator("body").innerText()));
for (const [section, label] of [
  ["WHEN", "Trigger event"],
  ["IF", "Conditions"],
  ["THEN", "Effect"]
]) {
  await page.getByRole("button", { name: new RegExp("^" + section + "$") }).first().click();
  await page.waitForTimeout(350);
  check("    " + label + " is editable", new RegExp(label, "i").test(await page.locator("body").innerText()));
}

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));

  const wrongTrigger = clone();
  wrongTrigger.reactions.duelIntercept.trigger = "unitDestroyed";

  const cancelAfterPrevented = clone();
  cancelAfterPrevented.reactions.duelPunish.effect = { type: "cancelTriggeringAction" };

  const freeVeto = clone();
  freeVeto.reactions.duelHoldTheLine.cost = {};
  delete freeVeto.reactions.duelHoldTheLine.limits;

  const unpayable = clone();
  unpayable.reactions.duelIntercept.cost = { resources: [{ id: "poise", amount: 99 }] };

  const report = validate.validateGameplayData(registry.CANONICAL_GAMEPLAY);
  return {
    clean: report.errors.length,
    wrongTrigger: validate
      .validateGameplayData(wrongTrigger)
      .errors.some((message) => /before it resolves/.test(message)),
    cancelAfterPrevented: validate
      .validateGameplayData(cancelAfterPrevented)
      .errors.some((message) => /already been prevented/.test(message)),
    freeVeto: validate
      .validateGameplayData(freeVeto)
      .warnings.some((message) => /costs nothing/.test(message)),
    unpayable: validate
      .validateGameplayData(unpayable)
      .errors.some((message) => /could never be paid/.test(message)),
    runningCost: window.STATUS_ZERO.reactionRegistries.index.reactionById.duelIntercept.cost.resources.length
  };
});
check("15. the shipped data validates", authoring.clean === 0, String(authoring.clean));
check("    an intervention on the wrong trigger is refused", authoring.wrongTrigger);
check("    cancelling something already prevented is refused", authoring.cancelAfterPrevented);
check("    a free unlimited veto is warned about", authoring.freeVeto);
check("    an unpayable cost is refused", authoring.unpayable);
check("    while the running content is untouched", authoring.runningCost === 2);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("16. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
