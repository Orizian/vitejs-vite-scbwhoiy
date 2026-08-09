/* Browser acceptance for the faction knowledge model.
 *
 * Drives the Vent Row fixture through the whole contact lifecycle in a real
 * browser, against the live game rather than a headless harness:
 *
 *   A  unseen        the garrison holds nothing on the infiltrator
 *   B  acquired      she crosses a sightline and the record appears
 *   C  contact lost  the bulkhead takes the sightline away, the tile survives
 *   D  reacquired    a thermal vent gives her away to the one sensor that can
 *   E  gone cold     the lead expires on the garrison's own clock
 *
 * Then the two properties the whole design rests on: the AI cannot target what
 * it has not acquired, and it hunts the memory rather than the unit.
 *
 *   npm run check:knowledge
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

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
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(base + "/", { waitUntil: "domcontentloaded" });
await page.evaluate(
  (t) => localStorage.setItem("statuszero.playtest.mission", t),
  readFileSync("src/content/missions/fixture-knowledge-slice.json", "utf8")
);
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.STATUS_ZERO && !!window.STATUS_ZERO.liveBattle, {
  timeout: 90000
});
await page.waitForTimeout(1500);

/* Helpers installed in the page: everything below drives the real battle. */
await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  window.__k = {
    unit: (ref) => {
      const b = S.liveBattle();
      const id = b.unitOrder.find((i) => b.units[i].ref === ref);
      return id ? b.units[id] : null;
    },
    id: (ref) => {
      const b = S.liveBattle();
      return b.unitOrder.find((i) => b.units[i].ref === ref) || null;
    },
    state: (faction, ref) => S.knowledgeStateOf(S.liveBattle(), faction, window.__k.id(ref)),
    record: (faction, ref) => {
      const b = S.liveBattle();
      const f = b.perception.factions[faction];
      return (f && f.units[window.__k.id(ref)]) || null;
    },
    put: (ref, x, y) => {
      const u = window.__k.unit(ref);
      u.x = x;
      u.y = y;
    },
    // Emit and drain, so a sweep reaches the mission script exactly as it
    // would during ordinary play.
    sweep: () => {
      const b = S.liveBattle();
      S.refreshPerception(b);
      S.missionEngine.processEvents(b);
      S.runMissionScript(b, { autoResolve: true });
    },
    /** Runs `n` activations for one unit, so its faction's clock advances. */
    idle: (ref, n) => {
      const b = S.liveBattle();
      const unitId = window.__k.id(ref);
      for (let i = 0; i < n; i += 1) {
        b.activeUnitId = null;
        b.activation = null;
        for (const id of b.unitOrder) {
          b.units[id].nextActionTime = id === unitId ? b.currentTime : b.currentTime + 100000;
        }
        S.executeCommand(b, { type: "activateUnit", unitId });
        S.executeCommand(b, { type: "wait", unitId });
      }
    },
    forget: () => {
      const b = S.liveBattle();
      for (const f of Object.keys(b.perception.factions)) b.perception.factions[f].units = {};
      b.perception.signatures = {};
    }
  };
});

const read = () =>
  page.evaluate(() => {
    const S = window.STATUS_ZERO;
    const b = S.liveBattle();
    return {
      phase: b.mission ? b.mission.phaseId : null,
      facts: b.mission ? { ...b.mission.facts } : {},
      infiltrator: window.__k.state("foe", "infiltrator"),
      record: window.__k.record("foe", "infiltrator"),
      clock: b.perception.factions.foe.clock,
      config: b.perception.config,
      log: b.battleLog.filter((l) => l.type === "knowledgeChanged").map((l) => l.text)
    };
  });

console.log("Vent Row fixture — the contact lifecycle");

/* ---- A: unseen ---- */
await page.evaluate(() => {
  window.__k.put("infiltrator", 2, 13);
  window.__k.put("overwatch", 4, 13);
  window.__k.put("sentry", 9, 0);
  window.__k.put("scanner", 12, 0);
  window.__k.put("listener", 15, 0);
  window.__k.forget();
  window.__k.sweep();
});
let s = await read();
check("A. the garrison starts with nothing on the infiltrator", s.infiltrator === "unseen", s.infiltrator);
check("   the mission is in its opening phase", s.phase === "approach", s.phase);

/* ---- B: acquired ---- */
await page.evaluate(() => {
  window.__k.put("infiltrator", 9, 1);
  window.__k.sweep();
});
s = await read();
check("B. crossing a sightline produces a firing solution", s.infiltrator === "acquired", s.infiltrator);
check(
  "   the record holds her real tile",
  s.record && s.record.x === 9 && s.record.y === 1,
  s.record && s.record.x + "," + s.record.y
);
check("   the transition reached the mission script", s.facts.everSpotted === true, "everSpotted=" + s.facts.everSpotted);

const targetable = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  return S.perceivedThreats(b, "foe")
    .filter((t) => t.unitId === window.__k.id("infiltrator"))
    .map((t) => t.targetable)[0];
});
check("   an acquired contact is targetable", targetable === true, String(targetable));

/* ---- C: contact lost ---- */
await page.evaluate(() => {
  // Deep behind the bulkheads: no observer has a line to this corner.
  window.__k.put("infiltrator", 2, 13);
  window.__k.sweep();
});
s = await read();
check("C. losing the sightline demotes to a contact", s.infiltrator === "suspected", s.infiltrator);
check(
  "   and leaves the tile she was last seen on",
  s.record && s.record.x === 9 && s.record.y === 1,
  s.record && s.record.x + "," + s.record.y
);
check("   the script saw the loss", s.facts.everLost === true, "everLost=" + s.facts.everLost);

const cannotShoot = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  const sentryId = window.__k.id("sentry");
  const infId = window.__k.id("infiltrator");
  // Put the sentry right on top of her: adjacency is not knowledge.
  b.units[sentryId].x = 6;
  b.units[sentryId].y = 5;
  const believed = S.believedPositionOf(b, "foe", infId, { minimumState: "acquired" });
  const threats = S.perceivedThreats(b, "foe").filter((t) => t.unitId === infId);
  return {
    believed,
    targetable: threats.length ? threats[0].targetable : null,
    believedTile: threats.length ? threats[0].x + "," + threats[0].y : null
  };
});
check("   no firing solution exists while she is only suspected", cannotShoot.believed === null);
check(
  "   the AI still points at the memory, not at her",
  cannotShoot.believedTile === "9,1",
  cannotShoot.believedTile
);

const hunts = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  const lead = S.searchTargetFor(b, window.__k.id("sentry"));
  return lead ? lead.x + "," + lead.y : null;
});
check("   and a searching unit is sent to that tile", hunts === "9,1", hunts);

/* ---- D: reacquisition through a thermal vent ---- */
await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  // Restore the sentry, then walk her into the vent row. The vent is a mission
  // action on a channel — nothing in it names her or her kit.
  const sentryId = window.__k.id("sentry");
  b.units[sentryId].x = 9;
  b.units[sentryId].y = 0;
  const scanner = window.__k.unit("scanner");
  scanner.x = 12;
  scanner.y = 11;
  window.__k.put("infiltrator", 12, 12);
  S.missionEngine.emitSignature(b, [window.__k.id("infiltrator")], "thermal", {
    strength: 2,
    duration: 2
  });
});
s = await read();
check("D. a thermal signature restores the firing solution", s.infiltrator === "acquired", s.infiltrator);
check(
  "   at her new position, not the old one",
  s.record && s.record.x === 12 && s.record.y === 12,
  s.record && s.record.x + "," + s.record.y
);

/* ---- E: the lead goes cold ---- */
const cold = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  // Seal her away behind the bulkhead again and let the garrison's own clock
  // run. Nothing here is a timer; it is the garrison taking turns.
  window.__k.put("infiltrator", 2, 13);
  window.__k.unit("scanner").x = 12;
  window.__k.unit("scanner").y = 0;
  window.__k.sweep();
  const afterLoss = S.knowledgeStateOf(b, "foe", window.__k.id("infiltrator"));
  window.__k.idle("sentry", b.perception.config.suspectedDecayActivations + 1);
  return {
    afterLoss,
    final: S.knowledgeStateOf(b, "foe", window.__k.id("infiltrator")),
    believed: S.believedPositionOf(b, "foe", window.__k.id("infiltrator"))
  };
});
check("E. she drops back to a contact when the sensor loses her", cold.afterLoss === "suspected", cold.afterLoss);
check("   and is forgotten once the lead is stale", cold.final === "unseen", cold.final);
check("   the last-known position goes with it", cold.believed === null, JSON.stringify(cold.believed));

s = await read();
check("   every transition is in the battle log", s.log.length >= 4, String(s.log.length));

/* ---- The two properties the design rests on ---- */
console.log("guarantees");

const differs = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  const infId = window.__k.id("infiltrator");
  // The player can see her; the garrison cannot. Same unit, same instant.
  return {
    player: S.knowledgeStateOf(b, "player", infId),
    foe: S.knowledgeStateOf(b, "foe", infId),
    playerOwnsHer: b.units[infId].teamId
  };
});
check(
  "two factions hold different beliefs about the same physical unit",
  differs.foe === "unseen",
  "foe=" + differs.foe + " owner=" + differs.playerOwnsHer
);

const noLeak = await page.evaluate(() => {
  const S = window.STATUS_ZERO;
  const b = S.liveBattle();
  const sentryId = window.__k.id("sentry");
  const weights = { targetProximity: 1, selfDanger: 1 };
  void weights;
  const before = S.chooseAiCommands(b, sentryId);
  // Teleport the unseen infiltrator next to the sentry. A cheating AI changes
  // its mind here; an honest one cannot even tell.
  window.__k.put("infiltrator", b.units[sentryId].x, b.units[sentryId].y + 1);
  const after = S.chooseAiCommands(b, sentryId);
  return {
    same: JSON.stringify(before) === JSON.stringify(after),
    before: JSON.stringify(before).slice(0, 120)
  };
});
check(
  "AI decisions do not change when an unknown hostile moves next to it",
  noLeak.same,
  noLeak.before
);

await page.screenshot({
  path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/knowledge-fixture.png"
});
check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((r) => r.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
