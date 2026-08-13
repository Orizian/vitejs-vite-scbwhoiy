/* Browser acceptance for rewards, drops and loot tables.
 *
 * The unit suite proves the arithmetic and the claim rules. This drives the
 * thing the phase is actually for, through the real runtime in a real page: a
 * mission is fought, a named enemy is destroyed, and the operation pays out —
 * once, with everything attributable to what produced it.
 *
 * The two checks worth reading are the idempotency one and the replay one.
 * Neither is observable from a screenshot; both are observable from adding the
 * campaign's stores up before and after, so that is what these do.
 *
 *   npm run check:reward
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
  const MISSION = "fixture-reward-bench";
  const arena = (seed) =>
    Z.createBattle("file:" + MISSION, seed, { autoResolveScenes: true, autoResolveReactions: true });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  /* A campaign that has begun this operation the given number of times. */
  const campaignAt = (attempt) => {
    const base = Z.campaign.create();
    return { ...base, attempts: { ...base.attempts, [MISSION]: attempt } };
  };
  const outcomeFrom = (state) => ({
    victory: true,
    activations: state.activationCount,
    conditions: { byOperator: {} },
    facts: {},
    defeated: Z.defeatedSources(state)
  });
  const totalOf = (receipt, kind, itemId) =>
    receipt.granted
      .filter((line) => line.kind === kind && line.itemId === itemId)
      .reduce((sum, line) => sum + line.quantity, 0);
`;

/* ---- 1. the bench, fought for real ---- */
console.log("\\nthe operation");

const fought = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(31);
  const roster = state.unitOrder.map((id) => ({
    ref: state.units[id].ref,
    definitionId: state.units[id].definitionId,
    teamId: state.units[id].teamId
  }));

  /* Destroy three of the four hostiles and deliberately leave one standing,
   * so the run proves that being present is not the same as being defeated. */
  const kill = (name) => {
    const unit = ref(state, name);
    unit.currentHp = 0;
    unit.alive = false;
  };
  kill("trooper");
  kill("elite");
  kill("namedCaptain");
  Z.settleBattle(state);

  const defeated = Z.defeatedSources(state);
  return {
    roster,
    defeated: defeated.map((entry) => entry.ref).sort(),
    survivorPresent: roster.some((entry) => entry.ref === "bystander"),
    survivorDefeated: defeated.some((entry) => entry.ref === "bystander"),
    sharedChassis:
      roster.find((entry) => entry.ref === "namedCaptain").definitionId ===
      roster.find((entry) => entry.ref === "trooper").definitionId
  };
})()`);

check("1. the bench fields a full enemy roster", fought.roster.length >= 6, fought.roster.length + " units");
check(
  "    the named captain shares the ordinary trooper's chassis",
  fought.sharedChassis,
  "which is why a placement override exists"
);
check("2. three hostiles were destroyed", fought.defeated.length === 3, fought.defeated.join(", "));
check("    the bystander was on the board", fought.survivorPresent);
check("    and is not among the defeated", !fought.survivorDefeated);

/* ---- 2. what the operation pays ---- */
console.log("\\nthe payout");

const payout = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(31);
  for (const name of ["trooper", "elite", "namedCaptain"]) {
    const unit = ref(state, name);
    unit.currentHp = 0;
    unit.alive = false;
  }
  Z.settleBattle(state);

  const campaign = campaignAt(1);
  const outcome = outcomeFrom(state);
  const receipt = Z.campaign.planRewards(campaign, MISSION, outcome);
  const model = Z.campaign.resultModel(campaign, MISSION, outcome, receipt);

  const applied = Z.campaign.applyRewards(campaign, receipt);
  /* Four more applications of the same receipt: a remount, a reload and two
   * impatient clicks are indistinguishable from this. */
  let doubled = applied.campaign;
  for (let i = 0; i < 4; i += 1) doubled = Z.campaign.applyRewards(doubled, receipt).campaign;

  return {
    funds: totalOf(receipt, "currency", "funds"),
    supplies: totalOf(receipt, "currency", "supplies"),
    intel: totalOf(receipt, "currency", "intel"),
    firstClearLines: model.reward.mission.filter((entry) => entry.firstClear).length,
    salvageLines: model.reward.salvage.length,
    salvageSources: model.reward.salvage.map((entry) => entry.sourceId),
    salvageLabels: model.reward.salvage.map((entry) => entry.sourceLabel),
    captainSalvage: model.reward.salvage.filter((entry) => entry.sourceId === "namedCaptain").length,
    appliedFunds: applied.campaign.funds - campaign.funds,
    appliedMaterials: Object.values(applied.campaign.materials).reduce((a, b) => a + b, 0),
    appliedEquipment: Object.keys(applied.campaign.inventory).length -
      Object.keys(campaign.inventory).length,
    doubledFunds: doubled.funds - campaign.funds,
    doubledMaterials: Object.values(doubled.materials).reduce((a, b) => a + b, 0)
  };
})()`);

check("3. the clear reward pays currency", payout.funds === 40 && payout.supplies === 6, "funds " + payout.funds);
check("    the first clear pays on top", payout.intel === 2 && payout.firstClearLines > 0);
check("4. salvage came off the wrecks", payout.salvageLines >= 3, payout.salvageLines + " lines");
check(
  "    and each line names the enemy it came from",
  payout.salvageSources.every(Boolean) && payout.captainSalvage > 0,
  payout.salvageSources.join(", ")
);
check(
  "    with a label a player can read",
  payout.salvageLabels.every((label) => label && label.length > 2),
  payout.salvageLabels[0]
);
check("5. applying moves currency, salvage and equipment", payout.appliedFunds === 40 && payout.appliedMaterials > 0);
check("    equipment landed in the existing inventory", payout.appliedEquipment > 0);
check(
  "6. applying the same receipt five times pays once",
  payout.doubledFunds === payout.appliedFunds && payout.doubledMaterials === payout.appliedMaterials,
  payout.doubledFunds + " funds, " + payout.doubledMaterials + " salvage"
);

/* ---- 3. persistence and replay ---- */
console.log("\\npersistence");

const persisted = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(31);
  for (const name of ["trooper", "elite", "namedCaptain"]) {
    const unit = ref(state, name);
    unit.currentHp = 0;
    unit.alive = false;
  }
  Z.settleBattle(state);
  const outcome = outcomeFrom(state);

  const first = campaignAt(1);
  const afterFirst = Z.campaign.applyRewards(first, Z.campaign.planRewards(first, MISSION, outcome)).campaign;

  /* Through the real save slot, not a hand-written blob. */
  Z.campaign.write(Z.campaign.serialize(afterFirst));
  const reloaded = Z.campaign.load();

  /* A later, legitimate attempt. */
  const replayCampaign = { ...reloaded, attempts: { ...reloaded.attempts, [MISSION]: 2 } };
  const replayReceipt = Z.campaign.planRewards(replayCampaign, MISSION, outcome);
  const afterReplay = Z.campaign.applyRewards(replayCampaign, replayReceipt).campaign;

  const uniqueEntries = replayReceipt.granted.filter((line) => line.claim === "oncePerCampaign");
  const withheld = replayReceipt.skipped.filter((line) => line.skipped === "alreadyClaimed");

  return {
    reloadedMaterials: Object.values(reloaded.materials).reduce((a, b) => a + b, 0),
    firstMaterials: Object.values(afterFirst.materials).reduce((a, b) => a + b, 0),
    reloadedClaims: Object.keys(reloaded.rewardClaims).length,
    reloadedFunds: reloaded.funds,
    firstFunds: afterFirst.funds,
    reloadedEquipment: JSON.stringify(reloaded.inventory) === JSON.stringify(afterFirst.inventory),
    replayPaid: afterReplay.funds - reloaded.funds,
    replaySalvage:
      Object.values(afterReplay.materials).reduce((a, b) => a + b, 0) -
      Object.values(reloaded.materials).reduce((a, b) => a + b, 0),
    uniqueOffered: uniqueEntries.length,
    withheldCount: withheld.length,
    withheldReason: withheld.length ? withheld[0].skipped : null,
    equipmentUnchanged:
      JSON.stringify(afterReplay.inventory) === JSON.stringify(reloaded.inventory)
  };
})()`);

check(
  "7. salvage survives a save and a reload",
  persisted.reloadedMaterials === persisted.firstMaterials && persisted.reloadedMaterials > 0,
  persisted.reloadedMaterials + " units"
);
check("    so do currencies", persisted.reloadedFunds === persisted.firstFunds);
check("    so does equipment", persisted.reloadedEquipment);
check("    and so does the claim on the unique", persisted.reloadedClaims > 0, persisted.reloadedClaims + " claims");
check("8. a genuine replay pays again", persisted.replayPaid === 40 && persisted.replaySalvage > 0,
  "+" + persisted.replayPaid + " funds, +" + persisted.replaySalvage + " salvage");
check("    the unique is not offered a second time", persisted.uniqueOffered === 0);
check(
  "    and the refusal is reported rather than hidden",
  persisted.withheldCount > 0 && persisted.withheldReason === "alreadyClaimed"
);
check("    so the equipment inventory does not move", persisted.equipmentUnchanged);

/* ---- 4. determinism ---- */
console.log("\\ndeterminism");

const deterministic = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(31);
  for (const name of ["elite"]) {
    const unit = ref(state, name);
    unit.currentHp = 0;
    unit.alive = false;
  }
  Z.settleBattle(state);
  const outcome = outcomeFrom(state);

  const a = Z.campaign.planRewards(campaignAt(4), MISSION, outcome);
  const b = Z.campaign.planRewards(campaignAt(4), MISSION, outcome);

  /* A battle that consumed a different amount of the combat RNG must not
   * change what the loot rolls — that is the whole reason rolls hash a key
   * rather than drawing from the battle's stream. */
  const busy = arena(31);
  for (let i = 0; i < 40; i += 1) busy.randomState.counter += 1;
  const busyKill = ref(busy, "elite");
  busyKill.currentHp = 0;
  busyKill.alive = false;
  Z.settleBattle(busy);
  const c = Z.campaign.planRewards(campaignAt(4), MISSION, outcomeFrom(busy));

  const rolls = [];
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const receipt = Z.campaign.planRewards(campaignAt(attempt), MISSION, outcome);
    const rolled = receipt.granted.find((line) => line.roll);
    rolls.push(rolled ? rolled.entryId : "-");
  }

  return {
    identical: JSON.stringify(a.granted) === JSON.stringify(b.granted),
    unaffectedByCombatRng: JSON.stringify(a.granted) === JSON.stringify(c.granted),
    distinctOutcomes: new Set(rolls).size,
    receiptId: a.receiptId
  };
})()`);

check("9. the same attempt always rolls the same loot", deterministic.identical, deterministic.receiptId);
check(
  "    and a busier battle does not change it",
  deterministic.unaffectedByCombatRng,
  "rolls hash a key, they do not draw from the combat stream"
);
check(
  "10. different attempts can roll differently",
  deterministic.distinctOutcomes > 1,
  deterministic.distinctOutcomes + " distinct results over 12 attempts"
);

/* ---- 5. provenance ---- */
console.log("\\nprovenance");

const provenance = await page.evaluate(`(() => {
  ${PRELUDE}
  const tables = Z.campaign.sourcesGranting("material", "prototypeAlloy");
  const missions = [];
  for (const [missionId, file] of Object.entries(Z.missionContent.missions)) {
    const encounter = Z.content.encounters[file.encounterId];
    for (const unit of (encounter && encounter.units) || []) {
      const refName = unit.ref || unit.id;
      const tableId =
        (file.dropTableByRef || {})[refName] || (Z.content.units[unit.definitionId] || {}).dropTableId;
      if (tableId && tables.includes(tableId)) missions.push(missionId + ":" + refName);
    }
  }
  return { tables, missions };
})()`);

check(
  "11. a reverse source index is derivable from content alone",
  provenance.tables.length >= 3,
  provenance.tables.join(", ")
);
check(
  "    down to the placement that drops it",
  provenance.missions.includes("fixture-reward-bench:namedCaptain"),
  provenance.missions.join(", ")
);

/* ---- 6. authoring ---- */
console.log("\\nstudio");
await page.evaluate(() => {
  localStorage.removeItem("statuszero.gameplay.editorDraft");
  localStorage.removeItem("statuszero.gameplay.draft");
  localStorage.removeItem("statuszero.editor.mode");
  localStorage.removeItem("statuszero.campaign.slot");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1600);
await page.getByRole("button", { name: /^Gameplay Data$/ }).first().click();
await page.waitForTimeout(1200);

await page.getByRole("button", { name: /^Loot tables$/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Named Captain Cache/ }).first().click();
await page.waitForTimeout(700);
const tableText = await page.locator("body").innerText();
check("12. a loot table opens in the Studio", /Named Captain Cache/i.test(tableText));

await page.getByRole("button", { name: /^Guaranteed$/ }).first().click();
await page.waitForTimeout(500);
const guaranteedText = await page.locator("body").innerText();
const guaranteedJson = await page.locator("textarea").first().inputValue();
check("    guaranteed grants are editable", /signatureCore/.test(guaranteedJson));
check(
  "    the grant kinds are offered as a closed list",
  /currency/.test(guaranteedText) && /equipment/.test(guaranteedText) && /material/.test(guaranteedText)
);
check("    and so are the claim policies", /oncePerCampaign/.test(guaranteedText));

await page.getByRole("button", { name: /^Roll pools$/ }).first().click();
await page.waitForTimeout(500);
const poolText = await page.locator("body").innerText();
check("    roll pools are editable", /weight/i.test(poolText) && /rolls/i.test(poolText));

await page.getByRole("button", { name: /^Materials$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /Prototype Alloy/ }).first().click();
await page.waitForTimeout(600);
check("13. a material opens in the Studio", /Prototype Alloy/i.test(await page.locator("body").innerText()));

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));
  const errorsOf = (data) => validate.validateGameplayData(data, {}).errors;

  const unknownEquipment = clone();
  unknownEquipment.lootTables.namedCaptainCache.guaranteed[0].itemId = "noSuchPart";

  const unknownMaterial = clone();
  unknownMaterial.lootTables.standardSalvage.guaranteed[0].itemId = "noSuchMaterial";

  const badWeight = clone();
  badWeight.lootTables.restrictedTechnology.pools[0].entries[0].weight = 0;

  const duplicateEntry = clone();
  duplicateEntry.lootTables.eliteSalvage.guaranteed = [
    { id: "same", kind: "material", itemId: "servoAssembly", quantity: 1 },
    { id: "same", kind: "material", itemId: "servoAssembly", quantity: 1 }
  ];

  const badClaim = clone();
  badClaim.lootTables.namedCaptainCache.guaranteed[0].claim = "occasionally";

  const indexed = clone();
  delete indexed.lootTables.namedCaptainCache.guaranteed[0].id;

  const cycle = clone();
  cycle.lootTables.restrictedTechnology.guaranteed = [{ tableId: "eliteSalvage" }];

  const unknownDrop = clone();
  unknownDrop.units.rifleGrunt.dropTableId = "noSuchTable";

  return {
    clean: errorsOf(registry.CANONICAL_GAMEPLAY).length,
    unknownEquipment: errorsOf(unknownEquipment).some((m) => /noSuchPart/.test(m)),
    unknownMaterial: errorsOf(unknownMaterial).some((m) => /noSuchMaterial/.test(m)),
    badWeight: errorsOf(badWeight).some((m) => /weight of zero or less/.test(m)),
    duplicateEntry: errorsOf(duplicateEntry).some((m) => /reuses entry id/.test(m)),
    badClaim: errorsOf(badClaim).some((m) => /occasionally/.test(m)),
    indexed: errorsOf(indexed).some((m) => /stable id/.test(m)),
    cycle: errorsOf(cycle).some((m) => /cycle/.test(m)),
    unknownDrop: errorsOf(unknownDrop).some((m) => /noSuchTable/.test(m)),
    runningIntact: window.STATUS_ZERO.campaign.lootTables.namedCaptainCache.guaranteed[0].itemId
  };
});
check("14. the shipped data validates", authoring.clean === 0, String(authoring.clean));
check("    unknown equipment in a table is refused", authoring.unknownEquipment);
check("    unknown material is refused", authoring.unknownMaterial);
check("    a zero weight is refused", authoring.badWeight);
check("    a duplicate entry id is refused", authoring.duplicateEntry);
check("    an unknown claim policy is refused", authoring.badClaim);
check("    an entry with no stable id is refused", authoring.indexed);
check("    a cycle between tables is refused", authoring.cycle);
check("    a chassis dropping an unknown table is refused", authoring.unknownDrop);
check("    while the running content is untouched", authoring.runningIntact === "overclockCore");

/* ---- 7. the mission owns its rewards ---- */
await page.getByRole("button", { name: /^Missions$/ }).first().click();
await page.waitForTimeout(1400);
// The editor opens on a fresh mission; the inspector's Mission section is
// where the reward block lives.
await page.getByRole("button", { name: /^Mission$/ }).first().click();
await page.waitForTimeout(700);
const missionText = await page.locator("body").innerText();
check(
  "15. the mission editor authors rewards",
  /Clear reward/i.test(missionText) && /First-clear reward/i.test(missionText)
);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("16. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
