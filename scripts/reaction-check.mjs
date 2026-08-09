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

const boot = async (missionPath) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("statuszero.playtest.mission", t), readFileSync(missionPath, "utf8"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.STATUS_ZERO && !!window.STATUS_ZERO.liveBattle, { timeout: 90000 });
  await page.waitForTimeout(1800);
  return page;
};

/* ============ PART 1: Section Seven in an Act-I-style battle ============ */
console.log("Section Seven fixture");
const s7 = await boot("src/content/missions/fixture-section-seven.json");

const snap = () => s7.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const m = S.reactionModel(b);
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  return {
    link: m.links[0] ? { active: m.links[0].active, reason: m.links[0].reason,
      pool: m.links[0].pool ? m.links[0].pool.current + "/" + m.links[0].pool.max : null } : null,
    window: m.window ? { trigger: m.window.triggerText, offers: m.window.offers.map(o => o.name + "|" + o.reactorRef + "|" + o.costText) } : null,
    reactions: b.battleLog.filter(l => l.type === "reaction").map(l => l.text),
    drillAHp: u("drillA") ? u("drillA").currentHp : null,
    drillAAlive: u("drillA") ? u("drillA").alive : null,
    valePos: u("vale") ? u("vale").x + "," + u("vale").y : null,
    valeHp: u("vale") ? u("vale").currentHp : null,
    activeUnit: b.activeUnitId,
    linkStripText: (document.body.innerText.match(/SECTION SEVEN/i) || [])[0] || null
  };
});

let s0 = await snap();
check("1. Section Seven is live in an Act-I-style battle", s0.link && s0.link.active, s0.link && s0.link.pool);
check("   the link readout is on screen", !!s0.linkStripText, s0.linkStripText);
await s7.screenshot({ path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/s7-start.png" });

// Stage the chain and have Vale mark. `giveTurnTo` makes a unit genuinely
// next on the timeline — clearing activeUnitId alone is not enough, because
// activation is validated against the timeline order.
const STAGE_HELPER = `
  window.__giveTurnTo = (b, S, unitId) => {
    b.activeUnitId = null; b.activation = null;
    for (const id of b.unitOrder) {
      b.units[id].nextActionTime = id === unitId ? b.currentTime : b.currentTime + 10000;
    }
    return S.executeCommand(b, { type: "activateUnit", unitId });
  };
`;
await s7.evaluate(STAGE_HELPER);
await s7.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  const vale = u("vale"), kell = u("kell"), reyes = u("reyes"), a = u("drillA");
  vale.x = 7; vale.y = 10; kell.x = 6; kell.y = 12; reyes.x = 8; reyes.y = 12; a.x = 7; a.y = 7;
  window.__giveTurnTo(b, S, vale.id);
});
await s7.evaluate(() => window.STATUS_ZERO.refreshUi());
await s7.waitForTimeout(300);
const beforeMark = await snap();
await s7.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  S.executeCommand(b, { type: "useAbility", unitId: u("vale").id, abilityId: "targetMark", target: { unitId: u("drillA").id } });
  window.STATUS_ZERO.refreshUi();
});
await s7.waitForTimeout(400);
let s1 = await snap();
check("2. Vale marks a target and a reaction prompt appears", !!s1.window, s1.window && s1.window.trigger);
check("   the prompt names who reacts and what it costs", !!(s1.window && /Kell|kell/.test(s1.window.offers[0])), s1.window && s1.window.offers[0]);
await s7.screenshot({ path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/s7-prompt.png" });

// Accept through the UI.
await s7.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Fire on the Mark/.test(x.textContent));
  if (b) b.click();
});
await s7.waitForTimeout(500);
let s2 = await snap();
check("3. Kell reacts out of turn", s2.reactions.some(r => /kell reacts: Fire on the Mark/.test(r)), s2.reactions[0]);
check("   Kell did not become the active unit", s2.activeUnit !== null && s2.activeUnit === beforeMark.activeUnit, s2.activeUnit);
check("4. Kell destroys the target", s2.drillAAlive === false, "hp " + s2.drillAHp);

// Vale's advance may itself be a second prompt.
if (s2.window) {
  await s7.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Into the Opening/.test(x.textContent));
    if (b) b.click();
  });
  await s7.waitForTimeout(500);
}
let s3 = await snap();
check("5. Vale receives his movement opportunity", s3.reactions.some(r => /vale reacts: Into the Opening/.test(r)) && s3.valePos !== beforeMark.valePos,
  beforeMark.valePos + " -> " + s3.valePos);
check("8a. shared capacity decreased", s3.link.pool !== s0.link.pool, s0.link.pool + " -> " + s3.link.pool);

// Reyes repair -> partial action.
await s7.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  const vale = u("vale"), reyes = u("reyes"), c = u("drillC");
  vale.currentHp = 40; c.x = vale.x; c.y = Math.max(0, vale.y - 2);
  reyes.x = vale.x; reyes.y = Math.min(17, vale.y + 1);
  window.__giveTurnTo(b, S, reyes.id);
  b.reactions.economy.pools.sectionSevenLink.current = 2;
  S.executeCommand(b, { type: "useAbility", unitId: reyes.id, abilityId: "fieldRepair", target: { unitId: vale.id } });
  window.STATUS_ZERO.refreshUi();
});
await s7.waitForTimeout(400);
let s4 = await snap();
if (s4.window) {
  await s7.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Back in the Fight/.test(x.textContent));
    if (b) b.click();
  });
  await s7.waitForTimeout(500);
  s4 = await snap();
}
check("6. Reyes repairs Vale", s4.valeHp > 40, "hp " + s4.valeHp);
check("7. the repaired frame takes a partial action", s4.reactions.some(r => /Back in the Fight/.test(r)), s4.reactions.slice(-1)[0]);
check("8b. shared pool decreased again", s4.link.pool !== "2/2", s4.link.pool);
await s7.screenshot({ path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/s7-chain.png" });

/* ============ PART 2: Grayfield restores the link mid-battle ============ */
console.log("Grayfield fixture");
const gf = await boot("src/content/missions/fixture-grayfield-slice.json");
const gsnap = () => gf.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const m = S.reactionModel(b);
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  const link = m.links.find(l => l.id === "sectionSeven");
  return {
    phase: b.mission.phaseId,
    link: { active: link.active, enabled: link.enabled, reason: link.reason,
      pool: link.pool ? link.pool.current + "/" + link.pool.max : null, available: link.pool ? link.pool.available : null },
    kellHostile: u("vale") && u("kell") ? S.isHostile(b, u("vale").id, u("kell").id) : null,
    kellId: u("kell") ? u("kell").id : null,
    reactions: b.battleLog.filter(l => l.type === "reaction").map(l => l.text),
    linkLog: b.battleLog.filter(l => l.type === "reactionLink").map(l => l.text),
    waiting: !!(b.mission && b.mission.wait)
  };
});
const g0 = await gsnap();
check("9. Kell and Reyes begin hostile", g0.kellHostile === true);
check("10. the Link is unavailable", g0.link.active === false && g0.link.available === false, g0.link.reason);

// Drive to the reversal.
for (let i = 0; i < 400; i += 1) {
  const st = await gf.evaluate(() => {
    const b = window.STATUS_ZERO.liveBattle();
    return { waiting: !!(b.mission && b.mission.wait), reactionWindow: !!(b.reactions && b.reactions.window),
      phase: b.mission.phaseId, finished: b.finished };
  });
  if (st.finished || st.phase === "counterattack") break;
  if (st.waiting || st.reactionWindow) {
    await gf.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const choice = buttons.find((x) => /Take the shot/.test(x.textContent));
      if (choice) return choice.click();
      const cont = buttons.find((x) => /^(Next|Continue)$/.test(x.textContent.trim()));
      if (cont) return cont.click();
      const decline = buttons.find((x) => /^Decline$/.test(x.textContent.trim()));
      if (decline) decline.click();
    });
    await gf.waitForTimeout(160);
    continue;
  }
  await gf.keyboard.press("q");
  await gf.waitForTimeout(60);
}
const g1 = await gsnap();
check("11-12. the scripted defection ran and factions changed", g1.phase === "counterattack" && g1.kellHostile === false, g1.phase);
check("13. mission scripting enabled Section Seven", g1.link.enabled === true);
check("14. the Link came online without leaving the battle", g1.linkLog.some(t => /is available/.test(t)), g1.linkLog.slice(-1)[0]);
check("    Kell was never recreated", g1.kellId === g0.kellId, g0.kellId + " -> " + g1.kellId);
await gf.screenshot({ path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/gf-link.png" });

// Save mid-sequence, then fire a Link reaction.
const saveCheck = await gf.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const saved = S.serializeBattle(b);
  const restored = S.deserializeBattle(saved);
  const link = (st) => S.reactionModel(st).links.find(l => l.id === "sectionSeven");
  return {
    identical: S.serializeBattle(restored) === saved,
    linkSurvived: link(restored).enabled === link(b).enabled && link(restored).active === link(b).active,
    poolSurvived: JSON.stringify(restored.reactions.economy.pools) === JSON.stringify(b.reactions.economy.pools)
  };
});
check("    save/reload preserves link and pool state", saveCheck.identical && saveCheck.linkSurvived && saveCheck.poolSurvived, JSON.stringify(saveCheck));

const chain = await gf.evaluate(() => {
  const S = window.STATUS_ZERO, b = S.liveBattle();
  const u = (r) => b.unitOrder.map(i => b.units[i]).find(x => x.ref === r);
  const vale = u("vale"), kell = u("kell"), reyes = u("reyes");
  for (const unit of [vale, kell, reyes]) { if (unit) { unit.alive = true; unit.currentHp = Math.max(unit.currentHp, 80); } }
  const enemy = b.unitOrder.map(i => b.units[i]).find(x => x.alive && x.teamId === "foe");
  if (!enemy) return { noEnemy: true };
  vale.x = enemy.x; vale.y = Math.min(21, enemy.y + 2);
  kell.x = Math.max(0, enemy.x - 1); kell.y = Math.min(21, enemy.y + 3);
  reyes.x = Math.min(19, enemy.x + 1); reyes.y = Math.min(21, enemy.y + 3);
  S.refreshReactionLinks(b);
  const before = enemy.currentHp;
  b.activeUnitId = null; b.activation = null;
  for (const id of b.unitOrder) {
    b.units[id].nextActionTime = id === vale.id ? b.currentTime : b.currentTime + 10000;
  }
  S.executeCommand(b, { type: "activateUnit", unitId: vale.id });
  b.reactions.economy.pools.sectionSevenLink.current = 2;
  S.executeCommand(b, { type: "useAbility", unitId: vale.id, abilityId: "targetMark", target: { unitId: enemy.id } });
  window.STATUS_ZERO.refreshUi();
  return { before, pendingWindow: !!b.reactions.window, active: S.reactionModel(b).links.find(l => l.id === "sectionSeven").active };
});
if (chain.pendingWindow) {
  await gf.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Fire on the Mark/.test(x.textContent));
    if (b) b.click();
  });
  await gf.waitForTimeout(400);
}
const g2 = await gsnap();
check("15. a Link reaction executed before mission end", g2.reactions.length > 0, g2.reactions.slice(-1)[0]);
await gf.screenshot({ path: "/tmp/claude-0/-home-user-vitejs-vite-scbwhoiy/373be2c1-4c49-5f6a-bb10-e793439dadc5/scratchpad/gf-chain.png" });

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
const failed = results.filter(r => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " browser checks passed");
process.exit(failed.length ? 1 : 0);
