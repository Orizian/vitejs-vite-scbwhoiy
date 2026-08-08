/* Browser acceptance check for the mission scripting architecture.
 *
 * Drives the real loop — editor validation -> Playtest -> live battle -> the
 * mid-battle reversal -> save/reload — and asserts on authoritative battle
 * state rather than on what is drawn. Complements `npm test`, which covers the
 * same ground headlessly.
 *
 *   npm run check:grayfield          against a dev server on :5173
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const base = process.env.URL || "http://localhost:5173";
const missionText = readFileSync("src/content/missions/fixture-grayfield-slice.json", "utf8");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail: detail == null ? "" : String(detail) });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail == null ? "" : "  [" + detail + "]"));
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium"
});
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];

try {
  /* ---- 1. the editor validates the fixture and enables Playtest ---- */
  console.log("editor");
  const editor = await context.newPage();
  editor.on("pageerror", (error) => pageErrors.push("editor: " + error.message));
  await editor.goto(base + "/editor.html", { waitUntil: "networkidle" });
  await editor.waitForSelector("canvas");
  await editor.evaluate(async (text) => {
    const module = await import("/src/content/mission-format.js");
    localStorage.setItem("statuszero.editor.draft", JSON.stringify(module.parseMission(text)));
  }, missionText);
  await editor.reload({ waitUntil: "networkidle" });
  await editor.waitForSelector("canvas");
  await editor.waitForTimeout(700);

  const validationText = await editor.locator("aside").nth(1).innerText();
  check("fixture validates with no errors", /Valid/.test(validationText), validationText.split("\n")[0]);
  check("Playtest is enabled", await editor.getByRole("button", { name: /Playtest/ }).isEnabled());

  const nav = editor.getByRole("navigation");
  for (const tab of ["Factions", "Groups", "Objectives", "Phases", "Triggers"]) {
    await nav.getByRole("button", { name: tab, exact: true }).click();
    await editor.waitForTimeout(120);
  }
  await nav.getByRole("button", { name: "Phases", exact: true }).click();
  await editor.waitForTimeout(200);
  await editor.locator("aside").first().getByText("The turn").first().click();
  await editor.waitForTimeout(300);
  const phaseText = await editor.locator("aside").first().innerText();
  check(
    "phase editor lists the scripted actions",
    ["Scripted attack", "Scripted repair", "Change faction relationship", "Replace objectives", "Spawn group"]
      .every((label) => phaseText.includes(label))
  );
  check(
    "actions are labelled by authority",
    /changes battle state/.test(phaseText) && /presentation only/.test(phaseText)
  );

  /* ---- 2. the game boots into the fixture ---- */
  console.log("game");
  const game = await context.newPage();
  game.on("pageerror", (error) => pageErrors.push("game: " + error.message));
  await game.goto(base + "/", { waitUntil: "domcontentloaded" });
  await game.evaluate((text) => localStorage.setItem("statuszero.playtest.mission", text), missionText);
  await game.reload({ waitUntil: "networkidle" });
  await game.waitForFunction(() => !!window.STATUS_ZERO && !!window.STATUS_ZERO.liveBattle, { timeout: 90000 });
  await game.waitForTimeout(1500);

  const snapshot = () =>
    game.evaluate(() => {
      const api = window.STATUS_ZERO;
      const battle = api.liveBattle();
      const byRef = (ref) => battle.unitOrder.map((id) => battle.units[id]).find((unit) => unit.ref === ref);
      const vale = byRef("vale");
      const kell = byRef("kell");
      const prototype = byRef("prototype");
      return {
        phase: battle.mission.phaseId,
        objectives: battle.objectiveState.entries.map((entry) => entry.ref + ":" + entry.status),
        kellHostile: vale && kell ? api.isHostile(battle, vale.id, kell.id) : null,
        kellId: kell ? kell.id : null,
        kellTeam: kell ? kell.teamId : null,
        prototypeAlive: prototype ? prototype.alive : null,
        prototypeHp: prototype ? prototype.currentHp : null,
        facts: battle.mission.facts,
        flags: battle.mission.campaignFlagRequests.map((entry) => entry.flag),
        reserveOnField: !!byRef("reserveA"),
        aceDormant: byRef("loyalistAce") ? byRef("loyalistAce").dormant : null,
        unitCount: battle.unitOrder.length,
        waitingScene: battle.mission.wait ? battle.mission.wait.request.sceneRef : null,
        finished: battle.finished
      };
    });

  const before = await snapshot();
  check("starts in the interception phase", before.phase === "interception", before.phase);
  check("Kell starts hostile", before.kellHostile === true);
  check("the loyalist ace starts dormant", before.aceDormant === true);
  check("the reserve wave is off the map", before.reserveOnField === false);
  check("the phase's objective is active", before.objectives.join() === "surviveInterception:active", before.objectives);

  /* ---- 3. play until the reversal, clicking through the scenes ---- */
  console.log("mid-battle reversal");
  let savedMidScene = null;
  const scenesSeen = [];
  for (let step = 0; step < 400; step += 1) {
    const status = await game.evaluate(() => {
      const battle = window.STATUS_ZERO.liveBattle();
      return {
        waiting: !!(battle.mission && battle.mission.wait),
        sceneRef: battle.mission && battle.mission.wait ? battle.mission.wait.request.sceneRef : null,
        finished: battle.finished
      };
    });
    if (status.finished) break;

    if (status.waiting) {
      if (!scenesSeen.includes(status.sceneRef)) scenesSeen.push(status.sceneRef);
      // Save while suspended on the first cinematic, before its actions run.
      if (!savedMidScene && status.sceneRef === "grayfieldTurn") {
        savedMidScene = await game.evaluate(() => window.STATUS_ZERO.serializeBattle(window.STATUS_ZERO.liveBattle()));
      }
      // Clicked in-page: without the Tailwind CDN the backdrop is not
      // pointer-events-none and would swallow a synthetic mouse click.
      await game.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")];
        const choice = buttons.find((button) => /Take the shot|Give me a reason/.test(button.textContent));
        if (choice) return choice.click();
        const advance = buttons.find((button) => /^(Next|Continue)$/.test(button.textContent.trim()));
        if (advance) advance.click();
      });
      await game.waitForTimeout(170);
      continue;
    }
    await game.keyboard.press("q");
    await game.waitForTimeout(60);
  }

  const after = await snapshot();
  check("both cinematics played", scenesSeen.length === 2, scenesSeen.join(","));
  check("reached the counterattack phase", after.phase === "counterattack", after.phase);
  check("the prototype was destroyed authoritatively", after.prototypeAlive === false && after.prototypeHp === 0);
  check("Kell is no longer hostile", after.kellHostile === false);
  check("Kell was never recreated", after.kellId === before.kellId, before.kellId + " -> " + after.kellId);
  check("Kell never left their team", after.kellTeam === before.kellTeam, after.kellTeam);
  check("objectives were replaced", after.objectives.some((entry) => entry.startsWith("defeatLoyalists")), after.objectives);
  check("the ace woke up", after.aceDormant === false);
  check("the reserve wave spawned", after.reserveOnField === true && after.unitCount > before.unitCount);
  check("mission facts were set", after.facts.sectionSevenTurned === true && after.facts.prototypeDestroyed === true);
  check("a campaign flag was queued", after.flags.includes("sectionSevenRejoined"));

  /* ---- 4. the save taken mid-cinematic resumes without replaying ---- */
  console.log("save / reload");
  const save = await game.evaluate((serialized) => {
    const api = window.STATUS_ZERO;
    const restored = api.deserializeBattle(serialized);
    const byRef = (state, ref) => state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === ref);
    const out = {
      roundTripIdentical: api.serializeBattle(restored) === serialized,
      resumedOnScene: restored.mission.wait ? restored.mission.wait.request.sceneRef : null,
      prototypeAliveAtSave: byRef(restored, "prototype").alive
    };
    restored.autoResolveScenes = true;
    api.runMissionScript(restored);
    out.afterResume = {
      phase: restored.mission.phaseId,
      prototypeAlive: byRef(restored, "prototype").alive,
      turned: restored.mission.facts.sectionSevenTurned === true,
      flags: restored.mission.campaignFlagRequests.length,
      units: restored.unitOrder.length
    };
    api.runMissionScript(restored);
    api.runMissionScript(restored);
    out.afterReruns = {
      flags: restored.mission.campaignFlagRequests.length,
      units: restored.unitOrder.length,
      prototypeHp: byRef(restored, "prototype").currentHp
    };
    return out;
  }, savedMidScene);

  check("battle state round-trips byte-identically", save.roundTripIdentical);
  check("the save resumed on the same cinematic", save.resumedOnScene === "grayfieldTurn", save.resumedOnScene);
  check("nothing had run yet at save time", save.prototypeAliveAtSave === true);
  check("resuming completes the reversal", save.afterResume.phase === "counterattack" && save.afterResume.prototypeAlive === false && save.afterResume.turned);
  check(
    "re-running the script replays nothing",
    save.afterReruns.flags === save.afterResume.flags &&
      save.afterReruns.units === save.afterResume.units &&
      save.afterReruns.prototypeHp === 0,
    JSON.stringify(save.afterReruns)
  );

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " browser checks passed");
process.exit(failed.length ? 1 : 0);
