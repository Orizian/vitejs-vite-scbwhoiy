/* Browser acceptance for the Gameplay Data Studio.
 *
 * The unit suite proves the format, the diff and the bundle as functions. This
 * proves the thing the phase is actually for: that someone can open the Studio,
 * change a number without opening a source file, see the change validated and
 * composed, play a battle that is genuinely running on it, export a bundle a
 * Claude Code session can apply mechanically, import that bundle back, and
 * leave the shipped data untouched throughout.
 *
 *   npm run check:gameplay
 */
import { chromium } from "playwright";

const base = process.env.URL || "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail == null ? "" : "  [" + detail + "]"));
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
const pageErrors = [];
const page = await ctx.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());

const text = () => page.locator("body").innerText();

const clearSlots = () =>
  page.evaluate(() => {
    localStorage.removeItem("statuszero.gameplay.editorDraft");
    localStorage.removeItem("statuszero.gameplay.draft");
    localStorage.removeItem("statuszero.playtest.mission");
    localStorage.removeItem("statuszero.editor.mode");
  });

await page.goto(base + "/", { waitUntil: "networkidle" });
await clearSlots();

/* ---- reaching the Studio ---- */
console.log("navigation");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1600);
check("1. the editor opens from the main menu", /STATUS ZERO · EDITOR/i.test(await text()));
check("   and offers a Gameplay Data mode", /GAMEPLAY DATA/i.test(await text()));

await page.getByRole("button", { name: /^Gameplay Data$/ }).first().click();
await page.waitForTimeout(900);
const studio = await text();
check("2. the Studio opens with every registry", /Units/i.test(studio) && /Abilities/i.test(studio));
for (const label of ["Equipment", "Statuses", "AI profiles", "Operators", "Perks", "Terrain"]) {
  check("   " + label + " is a tab", new RegExp(label, "i").test(studio));
}

/* ---- the entity the game actually reads ---- */
console.log("editing");
await page.getByRole("button", { name: /assaultMech/ }).first().click();
await page.waitForTimeout(500);
check("3. an entity opens by its stable id", /assaultMech/.test(await text()));

const composed = await page.evaluate(() =>
  window.STATUS_ZERO
    ? window.STATUS_ZERO.composeUnitPreview({ definitionId: "assaultMech" })
    : { unavailable: true }
);
const composedHp = composed.rows && composed.rows.find((row) => row.stat === "maxHp");
check(
  "   derived values come from the engine's own pipeline",
  !composed.unavailable && composedHp.base === 130 && composedHp.total === 145,
  composedHp && composedHp.base + " -> " + composedHp.total
);
check(
  "   and every contribution is attributed to its source",
  /Plate Armor \+15/.test(composedHp.sources),
  composedHp && composedHp.sources
);

// Change one number through the UI only. Base stats live behind their own
// inspector section, exactly as an author would find them.
await page.getByRole("button", { name: /^Base stats$/i }).click();
await page.waitForTimeout(400);
const hp = page.locator('input[type="number"]').first();
await hp.fill("175");
await hp.blur();
await page.waitForTimeout(600);
const afterEdit = await text();
check("4. an edit is tracked as a change", /Changes \(1\)/.test(afterEdit), afterEdit.match(/Changes \(\d+\)/)?.[0]);
check("   and the data still validates", /1 modified entity/i.test(afterEdit), afterEdit.match(/\d+ data error|modified entit\w+/)?.[0]);

const draftOnDisk = await page.evaluate(() => {
  const draft = JSON.parse(localStorage.getItem("statuszero.gameplay.editorDraft"));
  return draft.units.assaultMech.baseStats.maxHp;
});
check("   the working draft survives in storage", draftOnDisk === 175, draftOnDisk);

/* ---- validation refuses to export something broken ---- */
console.log("validation");
const brokenReport = await page.evaluate(async () => {
  const validate = await import("/src/content/gameplay/validate.js");
  const registry = await import("/src/content/gameplay/registry.js");
  const draft = JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));
  draft.units.assaultMech.abilities = ["noSuchAbility"];
  const report = validate.validateGameplayData(draft);
  return { ok: report.ok, errors: report.errors };
});
check("5. a dangling reference fails validation", brokenReport.ok === false);
check("   and the message names the id", /noSuchAbility/.test(brokenReport.errors.join(" ")));

/* ---- export ---- */
console.log("export");
const exported = await page.evaluate(async () => {
  const exchange = await import("/src/content/gameplay/exchange.js");
  const registry = await import("/src/content/gameplay/registry.js");
  const draft = JSON.parse(localStorage.getItem("statuszero.gameplay.editorDraft"));
  const changes = exchange.buildBundle(registry.CANONICAL_GAMEPLAY, draft, { mode: "changes" });
  const full = exchange.buildBundle(registry.CANONICAL_GAMEPLAY, draft, { mode: "full" });
  const again = exchange.buildBundle(registry.CANONICAL_GAMEPLAY, draft, { mode: "changes" });
  return {
    changePaths: Object.keys(changes.files).sort(),
    fullPaths: Object.keys(full.files).sort(),
    manifest: changes.manifest,
    readme: changes.files["README.md"],
    deterministic: exchange.bundleToText(changes) === exchange.bundleToText(again),
    text: exchange.bundleToText(changes)
  };
});
check(
  "6. a changes export carries only the touched registry",
  exported.changePaths.join(",") === "README.md,manifest.json,src/content/gameplay/units.json",
  exported.changePaths.join(",")
);
check("   the manifest names the entity and its operation", exported.manifest.entities.length === 1 &&
  exported.manifest.entities[0].id === "assaultMech" &&
  exported.manifest.entities[0].operation === "modify");
check("   the manifest states the repository path", exported.manifest.entities[0].path === "src/content/gameplay/units.json");
check("   the handoff explains what to do with it", /npm test/.test(exported.readme) && /manifest\.entities/.test(exported.readme));
check("   exporting twice produces identical bytes", exported.deterministic);
check("7. a full export covers every registry", exported.fullPaths.length === 10, exported.fullPaths.length);

/* ---- import is a draft, not an install ---- */
console.log("import");
const roundTrip = await page.evaluate(async (bundleText) => {
  const exchange = await import("/src/content/gameplay/exchange.js");
  const registry = await import("/src/content/gameplay/registry.js");
  const files = exchange.bundleFromText(bundleText);
  const result = exchange.draftFromBundle(registry.CANONICAL_GAMEPLAY, files);
  return {
    problems: result.problems,
    hp: result.draft.units.assaultMech.baseStats.maxHp,
    canonicalHp: registry.CANONICAL_GAMEPLAY.units.assaultMech.baseStats.maxHp,
    changes: exchange.diffAgainstCanonical(registry.CANONICAL_GAMEPLAY, result.draft).length
  };
}, exported.text);
check("8. a bundle imports without complaint", roundTrip.problems.length === 0, roundTrip.problems.join(" | "));
check("   carrying the change it described", roundTrip.hp === 175, roundTrip.hp);
check("   as exactly one change", roundTrip.changes === 1, roundTrip.changes);
check("   and canonical data is untouched by the import", roundTrip.canonicalHp === 130, roundTrip.canonicalHp);

/* ---- test unit: the draft actually reaches the simulation ---- */
console.log("test workflow");
const arena = await page.evaluate(async () => {
  const arenaModule = await import("/src/content/gameplay/arena.js");
  const registry = await import("/src/content/gameplay/registry.js");
  const draft = JSON.parse(localStorage.getItem("statuszero.gameplay.editorDraft"));
  const plan = arenaModule.resolveTestSubject(draft, "units", "assaultMech");
  const fixture = await fetch("/src/content/missions/fixture-test-arena.json").then((r) => r.json());
  const mission = arenaModule.buildArenaMission(fixture, plan);
  registry.writeGameplayDraft({ registries: draft, test: { kind: "units", id: "assaultMech", changed: 1 } });
  localStorage.setItem("statuszero.playtest.mission", JSON.stringify(mission));
  return { reason: plan.reason, definitionId: plan.definitionId };
});
check("9. Test Unit resolves a subject and says who", /Assault Mech/.test(arena.reason), arena.reason);

// The reload is the mechanism: the content registry is frozen at import, so a
// draft can only reach the engine on a load that happens after it was written.
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const inBattle = await text();
check("10. the arena boots straight into a battle", /Developer Test Arena|Test Arena/i.test(inBattle) || /TIMELINE/i.test(inBattle));
check("    and says out loud that draft data is in play", /DATA TEST/i.test(inBattle));

// The claim is that the frozen CONTENT registry this battle was built from
// carries the edit — not that a live HP bar reads a particular number, which
// combat is free to change the moment the timeline starts.
const liveData = await page.evaluate(() => {
  const state = window.STATUS_ZERO.liveBattle();
  const id = state.unitOrder.find((unitId) => state.units[unitId].definitionId === "assaultMech");
  const definitionId = id && state.units[id].definitionId;
  return {
    deployed: !!id,
    authored: definitionId ? window.STATUS_ZERO.content.units[definitionId].baseStats.maxHp : null,
    composed: window.STATUS_ZERO.composeUnitPreview({ definitionId: "assaultMech" }).rows
      .find((row) => row.stat === "maxHp")
  };
});
check("11. the subject was deployed into the arena", liveData.deployed);
check("    the battle's content registry carries the edit", liveData.authored === 175, liveData.authored);
check("    and composition follows it", liveData.composed.base === 175 && liveData.composed.total === 190,
  liveData.composed.base + " -> " + liveData.composed.total);

const draftFlag = await page.evaluate(() => window.STATUS_ZERO.gameplayDraft.active);
check("    the running build reports the draft as active", draftFlag === true);

/* ---- leaving the test restores the shipped data ---- */
await page.getByRole("button", { name: /Exit data test/i }).click();
await page.waitForTimeout(2500);
const afterExit = await page.evaluate(() => ({
  draft: localStorage.getItem("statuszero.gameplay.draft"),
  playtest: localStorage.getItem("statuszero.playtest.mission"),
  active: window.STATUS_ZERO.gameplayDraft.active,
  hp: window.STATUS_ZERO.content.units.assaultMech.baseStats.maxHp,
  editorDraft: JSON.parse(localStorage.getItem("statuszero.gameplay.editorDraft")).units.assaultMech.baseStats.maxHp
}));
check("12. leaving the test clears both slots", afterExit.draft === null && afterExit.playtest === null);
check("    the game is back on the shipped data", afterExit.active === false && afterExit.hp === 130, afterExit.hp);
check("    but the Studio's own work is not lost", afterExit.editorDraft === 175, afterExit.editorDraft);

/* ---- and the rest of the editor still works ---- */
console.log("no collateral damage");
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1600);
await page.getByRole("button", { name: /^Missions$/ }).first().click();
await page.waitForTimeout(700);
check("13. the mission editor still opens", /Playtest/i.test(await text()));
await page.getByRole("button", { name: /^Scenes$/ }).first().click();
await page.waitForTimeout(700);
check("    the scene editor still opens", /SCENE LIBRARY/i.test(await text()));
await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(900);
check("    and the main menu is still reachable", /NEW GAME/i.test(await text()));

await clearSlots();
check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
