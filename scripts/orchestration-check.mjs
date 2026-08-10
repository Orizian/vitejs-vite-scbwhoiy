/* Browser acceptance for the combat-orchestration layer.
 *
 * The unit suite proves the primitives as functions. This drives the thing the
 * phase is actually about: the chain a player would perform, through the real
 * runtime, in a real page — a prepared shooter reacts to a displaced enemy,
 * the kill hands an ally its own reaction, the squad pays for both, the battle
 * carries on afterwards, and the same sequence fails cleanly when the Command
 * Points are not there.
 *
 *   npm run check:orchestration
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

/* ---- the whole chain, on the real runtime ---- */
console.log("synergy chain");
const chain = await page.evaluate(() => {
  const Z = window.STATUS_ZERO;
  const state = Z.createBattle("file:fixture-synergy-arena", 32, {
    autoResolveScenes: true,
    autoResolveReactions: true
  });
  const byRef = (ref) => state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === ref);
  const kell = byRef("kell");
  const vale = byRef("vale");
  const hidden = byRef("hidden");
  const shover = byRef("shover");

  const out = { steps: [] };
  out.cpStart = Z.combatResources.faction(state, "sectionSeven").commandPoints.current;

  // 3. Prepare the reaction state, the same way pressing Overwatch would.
  Z.applyStatusTo(state, kell.id, "overwatching");
  out.prepared = state.units[kell.id].statuses.some((entry) => entry.statusId === "overwatching");

  // 4. The target is behind cover from the shooter's point of view.
  out.hiddenBefore = Z.canSeeTile(state, kell.id, { x: hidden.x, y: hidden.y });

  hidden.currentHp = 1;
  const valeBefore = { x: vale.x, y: vale.y };

  // 5. Something displaces it into the lane.
  Z.activateUnitForTest(state, shover.id);
  Z.forcePush(state, shover.id, hidden.id, 2);
  out.exposedAfter = Z.canSeeTile(state, kell.id, { x: hidden.x, y: hidden.y });

  // 6/7/8. The reaction resolves through the ordinary runtime.
  Z.autoResolveReactionWindows(state);
  out.fired = state.reactions.log.filter((entry) => entry.ok).map((entry) => entry.reactionId);
  out.cpAfter = Z.combatResources.faction(state, "sectionSeven").commandPoints.current;
  out.targetDown = !hidden.alive;

  // 9/10/11. The kill hands the ally its own reaction, which really moves it.
  out.allyMoved = vale.x !== valeBefore.x || vale.y !== valeBefore.y;

  // 12. And the battle has somewhere to go.
  out.continuation = Z.battleContinuation(state);
  out.errors = state.errors.slice();

  // The causal chain is inspectable.
  const trace = Z.causalTrace(state);
  out.viaReaction = trace
    .filter((entry) => entry.cause && entry.cause.viaReaction)
    .map((entry) => entry.type + "<-" + entry.cause.viaReactionId);
  out.forced = trace.filter((entry) => entry.cause && entry.cause.forced).map((entry) => entry.type);
  const deepest = trace.reduce(
    (best, entry) => (entry.cause && entry.cause.depth > (best.cause ? best.cause.depth : -1) ? entry : best),
    {}
  );
  out.deepestDepth = deepest.cause ? deepest.cause.depth : 0;
  out.deepestExplained = deepest.cause ? Z.describeCause(deepest.cause) : "";
  return out;
});

check("1. the squad starts with Command Points", chain.cpStart === 3, chain.cpStart);
check("2. the shooter can be put into a prepared state", chain.prepared);
check("3. the target starts behind cover from the shooter", chain.hiddenBefore === false);
check("4. displacing it exposes it", chain.exposedAfter === true);
check(
  "5. the prepared reaction fires on the displacement",
  chain.fired.includes("heldFiringLane"),
  chain.fired.join(",")
);
check("6. Command Points were spent", chain.cpAfter === chain.cpStart - 1, chain.cpStart + " -> " + chain.cpAfter);
check("7. the reaction killed the target", chain.targetDown);
check(
  "8. the kill opened the ally's reaction",
  chain.fired.includes("sectionSevenAdvance"),
  chain.fired.join(",")
);
check("9. which moved the ally for real", chain.allyMoved);
check(
  "10. and the battle has a valid continuation — no softlock",
  chain.continuation.kind !== "stalled" && chain.continuation.kind !== "reaction",
  chain.continuation.kind
);
check("    with no engine errors", chain.errors.length === 0, chain.errors.join(" | "));

console.log("causality");
check(
  "11. reaction consequences are attributed to their reaction",
  chain.viaReaction.length > 0,
  chain.viaReaction.slice(0, 3).join(", ")
);
check("    forced movement is marked forced", chain.forced.length > 0, chain.forced.join(","));
check("    and the chain is deep enough to be a chain", chain.deepestDepth >= 2, chain.deepestExplained);

/* ---- the same sequence with no Command Points ---- */
console.log("insufficient command points");
const broke = await page.evaluate(() => {
  const Z = window.STATUS_ZERO;
  const state = Z.createBattle("file:fixture-synergy-arena", 32, {
    autoResolveScenes: true,
    autoResolveReactions: true
  });
  const byRef = (ref) => state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === ref);
  const kell = byRef("kell");
  const hidden = byRef("hidden");
  const shover = byRef("shover");

  Z.applyStatusTo(state, kell.id, "overwatching");
  Z.combatResources.faction(state, "sectionSeven").commandPoints.current = 0;
  const hpBefore = hidden.currentHp;

  Z.activateUnitForTest(state, shover.id);
  Z.forcePush(state, shover.id, hidden.id, 2);
  Z.autoResolveReactionWindows(state);

  return {
    fired: state.reactions.log.filter((entry) => entry.ok).map((entry) => entry.reactionId),
    unharmed: hidden.currentHp === hpBefore && hidden.alive,
    cp: Z.combatResources.faction(state, "sectionSeven").commandPoints.current,
    continuation: Z.battleContinuation(state),
    errors: state.errors.slice()
  };
});
check("12. the reaction does not fire", !broke.fired.includes("heldFiringLane"), broke.fired.join(","));
check("    the target is untouched", broke.unharmed);
check("    nothing went negative", broke.cp === 0, broke.cp);
check("    and the battle is still valid", broke.continuation.kind !== "stalled", broke.continuation.kind);
check("    with no engine errors", broke.errors.length === 0, broke.errors.join(" | "));

/* ---- the timeline passive ---- */
console.log("timeline");
const timeline = await page.evaluate(() => {
  const Z = window.STATUS_ZERO;
  const run = (withPassive) => {
    const battle = Z.createBattle("file:fixture-synergy-arena", 41, {
      autoResolveScenes: true,
      autoResolveReactions: true
    });
    const find = (ref) =>
      battle.unitOrder.map((id) => battle.units[id]).find((unit) => unit.ref === ref);
    const killer = find("nyx");
    const victim = find("fragile");
    Z.applyStatusTo(battle, killer.id, "cloaked");
    if (!withPassive) battle.reactions.enabled = false;
    Z.activateUnitForTest(battle, killer.id);
    victim.currentHp = 1;
    Z.missionEngine.scriptedAttack(battle, {
      sourceUnitId: killer.id,
      targetUnitIds: [victim.id],
      power: 400,
      formula: "physical"
    });
    Z.autoResolveReactionWindows(battle);
    // A scripted attack charges no recovery, so give the activation an
    // ordinary action's worth before ending it — otherwise there is nothing
    // for a hasten to shorten and both runs land on zero.
    battle.activation.actionRecovery = 600;
    battle.activation.ended = true;
    return { battle, killer, victim };
  };

  const withPassive = run(true);
  const without = run(false);
  // Settle both through the ordinary command tail.
  for (const outcome of [withPassive, without]) {
    Z.settleBattle(outcome.battle);
  }

  return {
    killed: !withPassive.victim.alive,
    before: without.killer.nextActionTime,
    after: withPassive.killer.nextActionTime,
    logged: withPassive.battle.battleLog.some((entry) => entry.type === "timelineModified"),
    continuation: Z.battleContinuation(withPassive.battle)
  };
});
check("13. the melee kill landed", timeline.killed);
check("    the authored passive moved the real timeline", timeline.logged);
check(
  "    pulling the next activation earlier than the same kill without it",
  timeline.after < timeline.before,
  Math.round(timeline.before) + " -> " + Math.round(timeline.after)
);
check("    and the battle continues", timeline.continuation.kind !== "stalled", timeline.continuation.kind);

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
const studioText = await page.locator("body").innerText();
for (const label of ["Resources", "Reactions", "Combat links"]) {
  check("14. " + label + " is an editable registry", new RegExp(label, "i").test(studioText), null);
}
await page.getByRole("button", { name: /^Reactions$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /heldFiringLane/ }).first().click();
await page.waitForTimeout(500);
const reactionText = await page.locator("body").innerText();
check("    a reaction opens as WHEN / IF / THEN", /WHEN/.test(reactionText) && /THEN/.test(reactionText));
await page.getByRole("button", { name: /^WHEN$/ }).first().click();
await page.waitForTimeout(400);
check(
  "    and its trigger is chosen from the engine's own event list",
  /unitMoved/.test(await page.locator("body").innerText())
);

const draftIsolation = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const exchange = await import("/src/content/gameplay/exchange.js");
  const draft = JSON.parse(localStorage.getItem("statuszero.gameplay.editorDraft"));
  draft.resources.commandPoints.max = 9;
  const bundle = exchange.buildBundle(registry.CANONICAL_GAMEPLAY, draft, { mode: "changes" });
  return {
    paths: Object.keys(bundle.files).sort(),
    canonicalMax: registry.CANONICAL_GAMEPLAY.resources.commandPoints.max,
    runningMax: window.STATUS_ZERO.combatResources.definitions.find((entry) => entry.id === "commandPoints").max
  };
});
check(
  "15. the new registries export by path",
  draftIsolation.paths.includes("src/content/gameplay/resources.json"),
  draftIsolation.paths.join(",")
);
check("    editing a draft does not touch canonical data", draftIsolation.canonicalMax === 4);
check("    nor the running content", draftIsolation.runningMax === 4);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("16. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
