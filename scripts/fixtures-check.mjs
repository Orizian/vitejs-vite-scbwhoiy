/* Browser acceptance for battlefield fixtures.
 *
 * The unit suite proves the model as functions. This drives the thing the
 * phase is actually about, through the real runtime in a real page: an
 * operator prepares a tile nobody is standing on, a *different* operator
 * throws an enemy onto it, and the device goes off — with no engine code
 * connecting the two.
 *
 * The second half is the other half of the fantasy: a charge that deliberately
 * does nothing when walked on, and goes off when its owner decides three
 * enemies have stood in the wrong place long enough.
 *
 *   npm run check:fixtures
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
    Z.createBattle("file:fixture-sapper-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: false,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const rack = (state, unitId) => (state.units[unitId].resources || {}).ordnance;
`;

/* ---- placing one ---- */
console.log("placement");
const placed = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(120);
  const sapper = ref(state, "sapper");
  const walker = ref(state, "walker");
  const unitsBefore = state.unitOrder.length;
  const rackBefore = rack(state, sapper.id).current;
  Z.activateUnitForTest(state, sapper.id);

  const tile = { x: sapper.x + 2, y: sapper.y };
  const result = Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeMine",
    target: tile
  });
  const mine = Z.fixtures.at(state, tile.x, tile.y)[0];

  return {
    ok: result.ok,
    errors: result.errors || [],
    exists: !!mine,
    definitionId: mine ? mine.definitionId : null,
    owner: mine ? mine.ownerUnitId === sapper.id : false,
    state: mine ? mine.state : null,
    blocks: mine ? mine.blocksMovement : null,
    // The thing this concept exists to avoid.
    becameUnit: state.unitOrder.length !== unitsBefore,
    inUnitTable: mine ? !!state.units[mine.id] : false,
    // And the tile is still somewhere you can walk.
    walkable: Z.fixtures.tileIsFree(state, tile.x, tile.y, walker.id),
    rackBefore,
    rackAfter: rack(state, sapper.id).current,
    engineErrors: state.errors.slice()
  };
})()`);

check("1. the device is placed", placed.ok && placed.exists, (placed.errors || []).join(" | "));
check("   owned by whoever placed it, and armed", placed.owner && placed.state === "armed", placed.state);
check("2. it did not become a unit", !placed.becameUnit && !placed.inUnitTable);
check("   and its tile is still walkable", placed.walkable === true);
check("3. it cost a device from the rack", placed.rackAfter === placed.rackBefore - 1,
  placed.rackBefore + " → " + placed.rackAfter);
check("   with no engine errors", placed.engineErrors.length === 0, placed.engineErrors.join(" | "));

/* ---- who can see it ---- */
console.log("visibility");
const hidden = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(121);
  const sapper = ref(state, "sapper");
  const walker = ref(state, "walker");
  Z.activateUnitForTest(state, sapper.id);
  Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeMine",
    target: { x: sapper.x + 2, y: sapper.y }
  });

  const mine = Z.fixtures.all(state)[0];
  const beforeReveal = {
    owner: Z.fixtures.visibleTo(state, sapper.teamId).length,
    enemy: Z.fixtures.visibleTo(state, walker.teamId).length
  };
  // Everything the AI is handed, scanned for the device it must not know about.
  const plan = JSON.stringify(Z.chooseAiCommands(state, walker.id));
  const leaked = plan.includes(mine.id);

  mine.revealed = true;
  return {
    beforeReveal,
    afterReveal: Z.fixtures.visibleTo(state, walker.teamId).length,
    leaked,
    engineErrors: state.errors.slice()
  };
})()`);

check("4. its own side can see it", hidden.beforeReveal.owner === 1);
check("   the enemy cannot", hidden.beforeReveal.enemy === 0);
check("   and the AI is never handed it", hidden.leaked === false);
check("5. once found, it stays found", hidden.afterReveal === 1);
check("   with no engine errors", hidden.engineErrors.length === 0, hidden.engineErrors.join(" | "));

/* ---- walking onto one, and crossing one ---- */
console.log("pressure");
const pressure = await page.evaluate(`(() => {
  ${PRELUDE}
  const walkOn = arena(122);
  const target = ref(walkOn, "walker");
  target.x = 8;
  target.y = 2;
  const before = target.currentHp;
  Z.fixtures; // placed through the ordinary ability below
  const sapper = ref(walkOn, "sapper");
  sapper.x = 9;
  sapper.y = 2;
  Z.activateUnitForTest(walkOn, sapper.id);
  Z.executeCommand(walkOn, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeMine",
    target: { x: 7, y: 2 }
  });
  const mineId = Z.fixtures.at(walkOn, 7, 2)[0].id;
  Z.executeCommand(walkOn, { type: "endTurn", unitId: sapper.id });
  Z.settleBattle(walkOn);
  Z.activateUnitForTest(walkOn, target.id);
  Z.executeCommand(walkOn, {
    type: "move",
    unitId: target.id,
    path: [{ x: 8, y: 2 }, { x: 7, y: 2 }]
  });

  // Crossing one mid-path: A → B → C → D with the device on C.
  const cross = arena(123);
  const crosser = ref(cross, "walker");
  crosser.x = 16;
  crosser.y = 2;
  crosser.currentHp = 9999;
  const layer = ref(cross, "sapper");
  layer.x = 14;
  layer.y = 3;
  Z.activateUnitForTest(cross, layer.id);
  Z.executeCommand(cross, {
    type: "useAbility",
    unitId: layer.id,
    abilityId: "placeMine",
    target: { x: 14, y: 2 }
  });
  Z.executeCommand(cross, { type: "endTurn", unitId: layer.id });
  Z.settleBattle(cross);
  Z.activateUnitForTest(cross, crosser.id);
  Z.executeCommand(cross, {
    type: "move",
    unitId: crosser.id,
    path: [{ x: 16, y: 2 }, { x: 15, y: 2 }, { x: 14, y: 2 }, { x: 13, y: 2 }]
  });
  const detonation = cross.battleLog.filter((entry) => entry.type === "fixtureDetonated").pop();

  return {
    hurt: target.currentHp < before,
    consumed: !Z.fixtures.find(walkOn, mineId),
    crossHurt: crosser.currentHp < 9999,
    detonatedAt: detonation ? detonation.data.tile : null,
    finishedWalk: { x: crosser.x, y: crosser.y },
    continuation: Z.battleContinuation(cross).kind,
    engineErrors: walkOn.errors.concat(cross.errors)
  };
})()`);

check("6. walking onto an armed device sets it off", pressure.hurt);
check("   and the device is spent", pressure.consumed);
check("7. a device crossed mid-path triggers at its own tile",
  pressure.crossHurt && pressure.detonatedAt && pressure.detonatedAt.x === 14 && pressure.detonatedAt.y === 2,
  JSON.stringify(pressure.detonatedAt));
check("   and a survivor finishes the walk it started",
  pressure.finishedWalk.x === 13 && pressure.finishedWalk.y === 2,
  JSON.stringify(pressure.finishedWalk));
check("   with the battle still going", pressure.continuation !== "stalled", pressure.continuation);
check("   and no engine errors", pressure.engineErrors.length === 0, pressure.engineErrors.join(" | "));

/* ---- the acceptance ---- */
console.log("prepared ground + precise displacement");
const synergy = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(124);
  const sapper = ref(state, "sapper");
  const veteran = ref(state, "veteran");
  const bravo = ref(state, "bravo");
  bravo.currentHp = 9999;

  // 1. The sapper walks up and prepares a tile the enemy has no reason to
  //    walk to. Two tiles from her is inside what the ability allows.
  sapper.x = 6;
  sapper.y = 8;
  Z.activateUnitForTest(state, sapper.id);
  const place = Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeMine",
    target: { x: 8, y: 8 }
  });
  const mine = Z.fixtures.at(state, 8, 8)[0];
  const enemyStart = { x: bravo.x, y: bravo.y };

  // 2. A different operator, on its own turn, throws the enemy onto it.
  Z.executeCommand(state, { type: "endTurn", unitId: sapper.id });
  Z.settleBattle(state);
  Z.activateUnitForTest(state, veteran.id);
  const traceBefore = Z.causalTrace(state).length;
  const shove = Z.executeCommand(state, {
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

  const trace = Z.causalTrace(state).slice(traceBefore);
  const forced = trace.find((entry) => entry.type === "unitForcedMove");
  const detonated = trace.find((entry) => entry.type === "fixtureDetonated");
  const record = state.battleLog.filter((entry) => entry.type === "fixtureDetonated").pop();

  return {
    placed: place.ok,
    shoved: shove.ok,
    errors: (shove.errors || []).concat(place.errors || []),
    enemyStart,
    enemyEnd: { x: bravo.x, y: bravo.y },
    hurt: bravo.currentHp < 9999,
    consumed: !Z.fixtures.find(state, mine.id),
    activation: record ? record.data.activation : null,
    caughtIt: record ? record.data.targetUnitIds.includes(bravo.id) : false,
    attributedTo: record ? record.data.sourceUnitId === sapper.id : false,
    oneChain: !!(forced && detonated) && forced.cause.chainId === detonated.cause.chainId,
    blastBelowShove: !!(forced && detonated) && detonated.cause.depth > forced.cause.depth,
    forcedMarked: !!forced && !!forced.cause.forced,
    continuation: Z.battleContinuation(state).kind,
    engineErrors: state.errors.slice()
  };
})()`);

check("8. the tile is prepared and the enemy is thrown onto it",
  synergy.placed && synergy.shoved, (synergy.errors || []).join(" | "));
check("   landing exactly two tiles west of where it stood",
  synergy.enemyEnd.x === synergy.enemyStart.x - 2 && synergy.enemyEnd.y === synergy.enemyStart.y,
  JSON.stringify(synergy.enemyStart) + " → " + JSON.stringify(synergy.enemyEnd));
check("9. the device goes off under it", synergy.hurt && synergy.consumed);
check("   automatically — nobody pressed anything", synergy.activation === "automatic", synergy.activation);
check("   catching the frame that was thrown onto it", synergy.caughtIt);
check("10. the damage is still attributed to whoever laid it", synergy.attributedTo);
check("    the shove and the blast are one causal chain", synergy.oneChain);
check("    with the blast hanging below the shove", synergy.blastBelowShove);
check("    and the displacement marked forced", synergy.forcedMarked);
check("11. the battle carries on", synergy.continuation !== "stalled", synergy.continuation);
check("    with no engine errors", synergy.engineErrors.length === 0, synergy.engineErrors.join(" | "));

/* ---- the other half: player-chosen timing ---- */
console.log("remote charge");
const remote = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(125);
  const sapper = ref(state, "sapper");
  const packA = ref(state, "packA");
  const packB = ref(state, "packB");
  const packC = ref(state, "packC");
  for (const unit of [packA, packB, packC]) unit.currentHp = 9999;

  sapper.x = 14;
  sapper.y = 13;
  Z.activateUnitForTest(state, sapper.id);
  Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeCharge",
    target: { x: 16, y: 13 }
  });
  const charge = Z.fixtures.at(state, 16, 13)[0];

  // An enemy stands right on it and nothing happens. That is the difference.
  const stander = packA;
  const stoodOn = stander.currentHp;
  Z.executeCommand(state, { type: "endTurn", unitId: sapper.id });
  Z.settleBattle(state);
  Z.activateUnitForTest(state, stander.id);
  Z.executeCommand(state, {
    type: "move",
    unitId: stander.id,
    path: [{ x: 15, y: 12 }, { x: 16, y: 13 }]
  });
  const survivedStanding = stander.currentHp === stoodOn && !!Z.fixtures.find(state, charge.id);

  // Later, the operator decides.
  Z.executeCommand(state, { type: "endTurn", unitId: stander.id });
  Z.settleBattle(state);
  Z.activateUnitForTest(state, sapper.id);
  const offered = Z.fixtures.activatable(state, sapper.id, "detonate").map((entry) => entry.id);
  const command = {
    type: "activateFixture",
    unitId: sapper.id,
    abilityId: "detonate",
    fixtureId: charge.id
  };
  const validation = Z.validateCommand(state, command);
  const previewTargets = validation.valid ? validation.preview.targets.length : -1;
  const result = Z.executeCommand(state, command);
  const record = state.battleLog.filter((entry) => entry.type === "fixtureDetonated").pop();

  return {
    survivedStanding,
    offered,
    onlyCommandable: offered.length === 1 && offered[0] === charge.id,
    previewTargets,
    ok: result.ok,
    errors: result.errors || [],
    caught: [packA, packB, packC].filter((unit) => unit.currentHp < 9999).length,
    activation: record ? record.data.activation : null,
    consumed: !Z.fixtures.find(state, charge.id),
    continuation: Z.battleContinuation(state).kind,
    engineErrors: state.errors.slice()
  };
})()`);

check("12. a remote charge does nothing when stood on", remote.survivedStanding);
check("13. the detonator offers only devices it can command",
  remote.onlyCommandable, remote.offered.join(","));
check("    and the preview names everyone in the blast", remote.previewTargets === 3, remote.previewTargets);
check("14. detonating is a command that resolves", remote.ok, (remote.errors || []).join(" | "));
check("    catching all three", remote.caught === 3, remote.caught);
check("    recorded as chosen rather than triggered", remote.activation === "command", remote.activation);
check("    and the charge is spent", remote.consumed);
check("    with the battle still going", remote.continuation !== "stalled", remote.continuation);
check("    and no engine errors", remote.engineErrors.length === 0, remote.engineErrors.join(" | "));

/* ---- counterplay ---- */
console.log("counterplay");
const counter = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(126);
  const sapper = ref(state, "sapper");
  const walker = ref(state, "walker");

  // Somebody else's device is not yours to set off.
  Z.activateUnitForTest(state, sapper.id);
  Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeCharge",
    target: { x: sapper.x + 2, y: sapper.y }
  });
  const mine = Z.fixtures.all(state)[0];
  const theirs = Z.validateCommand(state, {
    type: "activateFixture",
    unitId: walker.id,
    abilityId: "detonate",
    fixtureId: mine.id
  });

  // A device that has been found can be walked up to and switched off.
  const defusing = arena(127);
  const layer = ref(defusing, "sapper");
  const enemy = ref(defusing, "walker");
  layer.x = 9;
  layer.y = 2;
  Z.activateUnitForTest(defusing, layer.id);
  Z.executeCommand(defusing, {
    type: "useAbility",
    unitId: layer.id,
    abilityId: "placeMine",
    target: { x: 7, y: 2 }
  });
  const found = Z.fixtures.at(defusing, 7, 2)[0];
  found.revealed = true;
  enemy.x = 8;
  enemy.y = 2;
  Z.executeCommand(defusing, { type: "endTurn", unitId: layer.id });
  Z.settleBattle(defusing);
  Z.activateUnitForTest(defusing, enemy.id);
  const defused = Z.executeCommand(defusing, {
    type: "activateFixture",
    unitId: enemy.id,
    abilityId: "defuse",
    fixtureId: found.id
  });
  const afterDefuse = Z.fixtures.find(defusing, found.id);
  const hpBefore = enemy.currentHp;
  Z.activateUnitForTest(defusing, enemy.id);
  Z.executeCommand(defusing, {
    type: "move",
    unitId: enemy.id,
    path: [{ x: 8, y: 2 }, { x: 7, y: 2 }]
  });

  // An empty rack makes the action honestly unavailable.
  const empty = arena(128);
  const dry = ref(empty, "sapper");
  Z.activateUnitForTest(empty, dry.id);
  rack(empty, dry.id).current = 0;
  const model = Z.abilityModel(empty, dry.id, "placeMine");

  return {
    refusedTheirs: theirs.valid === false,
    refusalReason: theirs.errors.join(" | "),
    defused: defused.ok && afterDefuse && afterDefuse.state === "disarmed",
    unharmedAfterDefuse: enemy.currentHp === hpBefore,
    dryUsable: model.usable,
    dryReason: model.unusableReason,
    engineErrors: state.errors.concat(defusing.errors, empty.errors)
  };
})()`);

check("15. you cannot set off somebody else's device", counter.refusedTheirs, counter.refusalReason);
check("16. a found device can be walked up to and switched off", counter.defused);
check("    and walking over it afterwards is safe", counter.unharmedAfterDefuse);
check("17. an empty rack makes placement honestly unavailable",
  counter.dryUsable === false, counter.dryReason);
check("    with no engine errors", counter.engineErrors.length === 0, counter.engineErrors.join(" | "));

/* ---- persistence and cost of scanning ---- */
console.log("persistence and performance");
const persisted = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(129);
  const sapper = ref(state, "sapper");
  Z.activateUnitForTest(state, sapper.id);
  Z.executeCommand(state, {
    type: "useAbility",
    unitId: sapper.id,
    abilityId: "placeMine",
    target: { x: sapper.x + 2, y: sapper.y }
  });
  const before = Z.fixtures.all(state)[0];
  const restored = Z.deserializeBattle(Z.serializeBattle(state));
  const after = restored ? Z.fixtures.find(restored, before.id) : null;

  const timings = {};
  for (const count of [5, 20, 50]) {
    const probe = arena(129);
    const walker = ref(probe, "walker");
    for (let index = 0; index < count; index += 1) {
      Z.executeCommand(probe, { type: "wait", unitId: walker.id });
    }
    // Place devices directly so the measurement is of the scan, not of the
    // placement ability's own cost.
    const layer = ref(probe, "sapper");
    for (let index = 0; index < count; index += 1) {
      probe.fixtures.byId["p" + index] = {
        id: "p" + index,
        definitionId: "pressureMine",
        x: 1 + (index % 20),
        y: 1 + Math.floor(index / 20),
        ownerTeamId: layer.teamId,
        ownerUnitId: layer.id,
        state: "armed",
        visibility: "ownerTeam",
        revealed: false,
        blocksMovement: false,
        charges: 1,
        consumedOnTrigger: true,
        triggerTiles: [],
        data: {}
      };
      probe.fixtures.order.push("p" + index);
    }
    const path = [];
    for (let x = 20; x >= 1; x -= 1) path.push({ x, y: 15 });
    const started = performance.now();
    const runs = 500;
    for (let index = 0; index < runs; index += 1) {
      Z.fixtures.at(probe, path[index % path.length].x, 15);
    }
    timings[count] = (performance.now() - started) / runs;
  }

  return {
    survived: !!after,
    sameTile: after ? after.x === before.x && after.y === before.y : false,
    sameState: after ? after.state === before.state : false,
    sameOwner: after ? after.ownerUnitId === before.ownerUnitId : false,
    timings
  };
})()`);

check("18. devices survive a save and reload", persisted.survived && persisted.sameTile);
check("    with their state and owner intact", persisted.sameState && persisted.sameOwner);
console.log(
  "    scan cost — 5: " + persisted.timings[5].toFixed(4) +
    "ms · 20: " + persisted.timings[20].toFixed(4) +
    "ms · 50: " + persisted.timings[50].toFixed(4) + "ms"
);
check("19. scanning stays trivial at 50 devices", persisted.timings[50] < 1,
  persisted.timings[50].toFixed(4) + "ms");

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
check("20. Fixtures is an editable registry", /Fixtures/i.test(studioText));
await page.getByRole("button", { name: /^Fixtures$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /pressureMine/ }).first().click();
await page.waitForTimeout(600);
check("    a device opens in the Studio", /Pressure Mine/i.test(await page.locator("body").innerText()));
for (const [section, label] of [
  ["On the map", "Who can see it"],
  ["State", "Activations"],
  ["What sets it off", "Triggered by"],
  ["What it does", "Affects"]
]) {
  await page.getByRole("button", { name: new RegExp("^" + section + "$") }).first().click();
  await page.waitForTimeout(350);
  check("    " + label + " is editable", new RegExp(label, "i").test(await page.locator("body").innerText()));
}

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const clone = () => JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));

  const unknownState = clone();
  unknownState.fixtures.pressureMine.initialState = "smouldering";

  const negative = clone();
  negative.fixtures.pressureMine.charges = -1;

  const invisibleWall = clone();
  invisibleWall.fixtures.pressureMine.blocksMovement = true;

  const selfPlacing = clone();
  selfPlacing.fixtures.pressureMine.effects.push({
    type: "placeFixture",
    definitionId: "pressureMine"
  });

  const danglingTag = clone();
  danglingTag.abilities.detonate.fixtureTargeting.tag = "nothingHasThis";

  const badRef = clone();
  badRef.abilities.placeMine.effects[0].definitionId = "noSuchDevice";

  const nested = clone();
  nested.fixtures.pressureMine.effects.push({
    type: "applyStatus",
    statusId: "noSuchStatus",
    chance: 1
  });

  return {
    clean: validate.validateGameplayData(registry.CANONICAL_GAMEPLAY).errors.length,
    unknownState: validate.validateGameplayData(unknownState).errors.some((m) => /smouldering/.test(m)),
    negative: validate.validateGameplayData(negative).ok === false,
    invisibleWall: validate.validateGameplayData(invisibleWall).errors.some((m) => /invisible wall/.test(m)),
    selfPlacing: validate.validateGameplayData(selfPlacing).errors.some((m) => /places itself/.test(m)),
    danglingTag: validate.validateGameplayData(danglingTag).errors.some((m) => /nothingHasThis/.test(m)),
    badRef: validate.validateGameplayData(badRef).errors.some((m) => /noSuchDevice/.test(m)),
    nested: validate.validateGameplayData(nested).errors.some((m) => /noSuchStatus/.test(m)),
    runningCharges: window.STATUS_ZERO.content.fixtures.pressureMine.charges
  };
});
check("21. the shipped data validates", authoring.clean === 0, authoring.clean);
check("    an unknown starting state is refused", authoring.unknownState);
check("    negative charges are refused", authoring.negative);
check("    a device that would be an invisible wall is refused", authoring.invisibleWall);
check("    a device that places itself is refused", authoring.selfPlacing);
check("    a detonator wired to a tag nothing carries is refused", authoring.danglingTag);
check("    a placement naming a device that does not exist is refused", authoring.badRef);
check("    and a dangling reference inside a device's effects is caught", authoring.nested);
check("    while the running content is untouched", authoring.runningCharges === 1);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("22. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
