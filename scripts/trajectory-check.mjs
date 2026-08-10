/* Browser acceptance for trajectory combat.
 *
 * The unit suite proves the primitives as functions. This drives the thing the
 * phase is actually about, through the real runtime in a real page: a frame
 * plans a route, the panel prices its turns, the player chooses an exact
 * displacement, and that exact tile is what opens a prepared shooter's lane.
 *
 * Every check compares what the *preview* promised against what the engine
 * then did. A tactics game whose preview and execution disagree by one tile is
 * worse than one with no preview at all, so that comparison is the whole test.
 *
 *   npm run check:trajectory
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

/* The harness every block below starts from: the arena, its units by ref, and
 * a frame that is about to act. Injected as a string because it runs inside
 * the page, not here. */
const PRELUDE = `
  const Z = window.STATUS_ZERO;
  const arena = (seed, options) =>
    Z.createBattle("file:fixture-trajectory-arena", seed, {
      autoResolveScenes: true,
      autoResolveReactions: false,
      ...(options || {})
    });
  const ref = (state, name) =>
    state.unitOrder.map((id) => state.units[id]).find((unit) => unit.ref === name);
  const burst = (state, unitId) => (state.units[unitId].resources || {}).burst;
`;

/* ---- a route, drawn the way a player draws it ---- */
console.log("planning");
const drawn = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(60);
  const mover = ref(state, "veteran");
  mover.x = 5;
  mover.y = 8;
  Z.activateUnitForTest(state, mover.id);

  let input = Z.trajectory.input(state, mover.id, "vectorRoute");
  const out = { started: input.mode, legs: [] };

  // Three clicks: along, turn, along again.
  for (const tile of [{ x: 8, y: 8 }, { x: 8, y: 5 }, { x: 10, y: 5 }]) {
    input = Z.trajectory.click(state, input, tile).input;
    out.legs.push(input.routeSegments.length);
  }

  // A tile off every heading is not a leg, and says so.
  const crooked = Z.trajectory.click(state, input, { x: 13, y: 9 });
  out.crookedLegs = crooked.input.routeSegments.length;
  out.crookedReason = crooked.input.errorMessage;

  const preview = Z.trajectory.preview(state, input, null);
  out.previewDistance = preview.distance;
  out.previewEndpoint = { ...preview.endpoint };
  out.previewTurns = preview.redirects;
  out.previewCost = preview.cost.amount;
  out.previewResource = preview.cost.resourceId;
  out.burstBefore = burst(state, mover.id).current;
  out.previewRemaining = preview.cost.remaining;

  const result = Z.executeCommand(state, Z.trajectory.commands(input)[0]);
  out.ok = result.ok;
  out.errors = result.errors || [];
  out.landed = { x: mover.x, y: mover.y };
  out.burstAfter = burst(state, mover.id).current;
  out.continuation = Z.battleContinuation(state).kind;
  out.engineErrors = state.errors.slice();
  return out;
})()`);

check("1. a route ability opens a route, not a target reticle", drawn.started === "planningRoute", drawn.started);
check("   each click lays exactly one leg", JSON.stringify(drawn.legs) === "[1,2,3]", drawn.legs.join(","));
check(
  "   a tile off every heading is refused, with a reason",
  drawn.crookedLegs === 3 && /straight/.test(drawn.crookedReason || ""),
  drawn.crookedReason
);
check("2. the preview prices the turns in the authored resource", drawn.previewResource === "burst", drawn.previewResource);
check("   two quarter turns at the authored price", drawn.previewCost === 2, JSON.stringify(drawn.previewTurns));
check("   and says what the bank will hold afterwards", drawn.previewRemaining === drawn.burstBefore - 2,
  drawn.burstBefore + " - 2 = " + drawn.previewRemaining);
check("3. the route runs", drawn.ok, (drawn.errors || []).join(" | "));
check(
  "   the frame lands exactly where the preview promised",
  drawn.landed.x === drawn.previewEndpoint.x && drawn.landed.y === drawn.previewEndpoint.y,
  JSON.stringify(drawn.landed) + " vs " + JSON.stringify(drawn.previewEndpoint)
);
check("   and pays exactly what the preview quoted", drawn.burstAfter === drawn.previewRemaining,
  drawn.burstAfter + " vs " + drawn.previewRemaining);
check("   with no engine errors", drawn.engineErrors.length === 0, drawn.engineErrors.join(" | "));
check("   and a battle that continues", drawn.continuation !== "stalled", drawn.continuation);

/* ---- a route nobody can pay for ---- */
console.log("insufficient burst");
const broke = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(61);
  const mover = ref(state, "veteran");
  mover.x = 5;
  mover.y = 8;
  Z.activateUnitForTest(state, mover.id);
  burst(state, mover.id).current = 0;

  let input = Z.trajectory.input(state, mover.id, "vectorRoute");
  for (const tile of [{ x: 8, y: 8 }, { x: 8, y: 5 }]) {
    input = Z.trajectory.click(state, input, tile).input;
  }
  const preview = Z.trajectory.preview(state, input, null);
  const command = Z.trajectory.commands(input)[0];
  const before = { x: mover.x, y: mover.y };
  const result = Z.executeCommand(state, command);
  return {
    quoted: preview.cost.amount,
    affordable: preview.cost.affordable,
    reason: preview.cost.reason,
    ran: result.ok,
    moved: mover.x !== before.x || mover.y !== before.y,
    bank: burst(state, mover.id).current,
    continuation: Z.battleContinuation(state).kind,
    engineErrors: state.errors.slice()
  };
})()`);

check("4. an empty bank cannot turn, and the panel says so first", broke.affordable === false, broke.reason);
check("   the command refuses rather than half-running", broke.ran === false);
check("   nothing moved", broke.moved === false);
check("   and nothing went negative", broke.bank === 0, broke.bank);
check("   with no engine errors", broke.engineErrors.length === 0, broke.engineErrors.join(" | "));

/* ---- precise displacement, chosen rather than maximal ---- */
console.log("precise displacement");
const precise = await page.evaluate(`(() => {
  ${PRELUDE}
  const runs = [];
  for (const chosen of [1, 2, 3, 4]) {
    const state = arena(62);
    const mover = ref(state, "veteran");
    const target = ref(state, "clusterA");
    mover.x = 8;
    mover.y = 8;
    target.x = 14;
    target.y = 8;
    target.currentHp = 999;
    Z.activateUnitForTest(state, mover.id);

    let input = Z.trajectory.input(state, mover.id, "machStrike");
    input = Z.trajectory.click(state, input, { x: 13, y: 8 }).input;
    input = Z.trajectory.click(state, input, { x: 14, y: 8 }).input;
    input = Z.trajectory.displace(state, input, { heading: "n", distance: chosen });

    const preview = Z.trajectory.preview(state, input, null);
    const promised = { ...preview.contacts[0].displacement.endpoint };
    const max = preview.contacts[0].maxDisplacement;
    Z.executeCommand(state, Z.trajectory.commands(input)[0]);
    runs.push({
      chosen,
      max,
      promised,
      landed: { x: target.x, y: target.y },
      hasContact: !!preview.contacts.length,
      inReach: preview.contacts[0].inReach,
      errors: state.errors.slice()
    });
  }
  return runs;
})()`);

check("5. clicking an enemy on the route attaches a contact", precise.every((run) => run.hasContact && run.inReach));
check("   the ability's ceiling comes from its own data", precise.every((run) => run.max === 4), precise[0].max);
for (const run of precise) {
  check(
    "   a chosen push of " + run.chosen + " lands exactly " + run.chosen + " tiles away",
    run.landed.x === run.promised.x &&
      run.landed.y === run.promised.y &&
      run.promised.y === 8 - run.chosen,
    JSON.stringify(run.landed) + " promised " + JSON.stringify(run.promised)
  );
}
check("   with no engine errors", precise.every((run) => run.errors.length === 0));

/* ---- a shove that will not land ---- */
console.log("blocked and braced displacement");
const blocked = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(63);
  const mover = ref(state, "veteran");
  const target = ref(state, "clusterA");
  const wall = ref(state, "clusterB");
  target.x = 14;
  target.y = 8;
  wall.x = 16;
  wall.y = 8;
  target.currentHp = 999;
  mover.x = 11;
  mover.y = 8;
  Z.activateUnitForTest(state, mover.id);

  let input = Z.trajectory.input(state, mover.id, "machStrike");
  input = Z.trajectory.click(state, input, { x: 13, y: 8 }).input;
  input = Z.trajectory.click(state, input, { x: 14, y: 8 }).input;
  input = Z.trajectory.displace(state, input, { heading: "e", distance: 4 });
  const preview = Z.trajectory.preview(state, input, null);
  const shove = preview.contacts[0].displacement;
  Z.executeCommand(state, Z.trajectory.commands(input)[0]);

  const braced = arena(64);
  const fast = ref(braced, "veteran");
  const anchor = ref(braced, "anchor");
  anchor.currentHp = 999;
  fast.x = anchor.x - 3;
  fast.y = anchor.y;
  Z.activateUnitForTest(braced, fast.id);
  let anchorInput = Z.trajectory.input(braced, fast.id, "machStrike");
  anchorInput = Z.trajectory.click(braced, anchorInput, { x: anchor.x - 1, y: anchor.y }).input;
  anchorInput = Z.trajectory.click(braced, anchorInput, { x: anchor.x, y: anchor.y }).input;
  anchorInput = Z.trajectory.displace(braced, anchorInput, { heading: "n", distance: 4 });
  const anchorPreview = Z.trajectory.preview(braced, anchorInput, null);
  const anchorShove = anchorPreview.contacts[0].displacement;
  const anchorStart = anchor.y;
  Z.executeCommand(braced, Z.trajectory.commands(anchorInput)[0]);

  return {
    previewActual: shove.actual,
    previewBlocked: shove.blocked,
    landedX: target.x,
    resisted: anchorShove.resisted,
    anchorPreviewActual: anchorShove.actual,
    anchorMoved: anchorStart - anchor.y,
    engineErrors: state.errors.concat(braced.errors)
  };
})()`);

check("6. the preview shows a shove stopping short of a wall", blocked.previewBlocked === true, blocked.previewActual);
check(
  "   and the target really stops there",
  blocked.landedX === 14 + blocked.previewActual,
  blocked.landedX
);
check("7. a braced target absorbs part of the push, before it is committed", blocked.resisted > 0, blocked.resisted);
check(
  "   and moves exactly as far as the preview said",
  blocked.anchorMoved === blocked.anchorPreviewActual,
  blocked.anchorMoved + " vs " + blocked.anchorPreviewActual
);
check("   with no engine errors", blocked.engineErrors.length === 0, blocked.engineErrors.join(" | "));

/* ---- the acceptance the phase is for ---- */
console.log("synergy: a chosen tile opens someone else's lane");
const synergy = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(65, { autoResolveReactions: true });
  const mover = ref(state, "veteran");
  const shooter = ref(state, "kell");
  const covered = ref(state, "covered");

  Z.applyStatusTo(state, shooter.id, "overwatching");
  Z.refreshReactionLinks(state);

  const out = {};
  out.hiddenBefore = Z.canSeeTile(state, shooter.id, { x: covered.x, y: covered.y });

  mover.x = 11;
  mover.y = 7;
  covered.currentHp = 999;
  Z.activateUnitForTest(state, mover.id);
  out.cpBefore = Z.combatResources.faction(state, "sectionSeven").commandPoints.current;

  let input = Z.trajectory.input(state, mover.id, "machStrike");
  input = Z.trajectory.click(state, input, { x: 11, y: 5 }).input;
  input = Z.trajectory.click(state, input, { x: 11, y: 4 }).input;
  input = Z.trajectory.displace(state, input, { heading: "n", distance: 2 });

  const preview = Z.trajectory.preview(state, input, null);
  out.promised = { ...preview.contacts[0].displacement.endpoint };
  out.approach = preview.distance;

  const result = Z.executeCommand(state, Z.trajectory.commands(input)[0]);
  out.ok = result.ok;
  out.errors = result.errors || [];
  out.landed = { x: covered.x, y: covered.y };
  out.exposedAfter = Z.canSeeTile(state, shooter.id, { x: covered.x, y: covered.y });

  Z.autoResolveReactionWindows(state);
  out.fired = state.reactions.log.filter((entry) => entry.ok).map((entry) => entry.reactionId);
  out.cpAfter = Z.combatResources.faction(state, "sectionSeven").commandPoints.current;
  out.shot = covered.currentHp < 999;
  out.continuation = Z.battleContinuation(state).kind;

  const trace = Z.causalTrace(state);
  out.forced = trace.some((entry) => entry.type === "unitForcedMove" && entry.cause && entry.cause.forced);
  out.viaReaction = trace.some((entry) => entry.cause && entry.cause.viaReactionId === "heldFiringLane");
  out.engineErrors = state.errors.slice();
  return out;
})()`);

check("8. the target starts behind cover from the shooter", synergy.hiddenBefore === false);
check("   the route reaches it", synergy.ok, (synergy.errors || []).join(" | "));
check(
  "   and the chosen tile is exactly where it lands",
  synergy.landed.x === synergy.promised.x && synergy.landed.y === synergy.promised.y,
  JSON.stringify(synergy.landed)
);
check("9. which is a tile the shooter can see", synergy.exposedAfter === true);
check("   the prepared reaction fires", synergy.fired.includes("heldFiringLane"), synergy.fired.join(","));
check("   the squad pays for it", synergy.cpAfter === synergy.cpBefore - 1,
  synergy.cpBefore + " -> " + synergy.cpAfter);
check("   and the shooter really fires", synergy.shot);
check("10. the displacement is attributed as forced", synergy.forced);
check("    the shot is attributed to the reaction that made it", synergy.viaReaction);
check("    and the battle continues — no softlock", synergy.continuation !== "stalled", synergy.continuation);
check("    with no engine errors", synergy.engineErrors.length === 0, synergy.engineErrors.join(" | "));

/* ---- grouping, and a route interrupted by its own consequences ---- */
console.log("grouping and interruption");
const grouping = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(66);
  const mover = ref(state, "veteran");
  const a = ref(state, "clusterA");
  const b = ref(state, "clusterB");
  a.x = 14;
  a.y = 8;
  b.x = 18;
  b.y = 8;
  a.currentHp = 999;
  b.currentHp = 999;
  const gapBefore = Math.abs(a.x - b.x);

  mover.x = 11;
  mover.y = 8;
  Z.activateUnitForTest(state, mover.id);
  let input = Z.trajectory.input(state, mover.id, "machStrike");
  input = Z.trajectory.click(state, input, { x: 13, y: 8 }).input;
  input = Z.trajectory.click(state, input, { x: 14, y: 8 }).input;
  input = Z.trajectory.displace(state, input, { heading: "e", distance: 3 });
  const promised = { ...Z.trajectory.preview(state, input, null).contacts[0].displacement.endpoint };
  Z.executeCommand(state, Z.trajectory.commands(input)[0]);

  // The route that walls itself in: the shove lands the target on the tile the
  // next leg wanted.
  const self = arena(67);
  const fast = ref(self, "veteran");
  const victim = ref(self, "clusterA");
  fast.x = 5;
  fast.y = 8;
  victim.x = 8;
  victim.y = 8;
  victim.currentHp = 999;
  Z.activateUnitForTest(self, fast.id);
  const plan = Z.trajectory.plan(
    self,
    fast.id,
    [{ heading: "e", distance: 2 }, { heading: "n", distance: 1 }, { heading: "e", distance: 2 }],
    "vectorRoute"
  );
  let route = Z.trajectory.input(self, fast.id, "vectorRoute");
  route = Z.trajectory.click(self, route, { x: 7, y: 8 }).input;
  route = Z.trajectory.click(self, route, { x: 8, y: 8 }).input;
  route = Z.trajectory.displace(self, route, { heading: "n", distance: 1 });
  route = Z.trajectory.click(self, route, { x: 7, y: 7 }).input;
  route = Z.trajectory.click(self, route, { x: 9, y: 7 }).input;
  Z.executeCommand(self, Z.trajectory.commands(route)[0]);
  const context = Z.trajectory.context(self);

  return {
    gapBefore,
    gapAfter: Math.abs(a.x - b.x),
    landedOn: { x: a.x, y: a.y },
    promised,
    plannedLegal: plan.legal,
    interrupted: context.interrupted,
    interruptReason: context.interruptReason,
    blockedBy: context.blockedBy === victim.id,
    overlap: fast.x === victim.x && fast.y === victim.y,
    engineErrors: state.errors.concat(self.errors)
  };
})()`);

check(
  "11. a chosen push groups two separated enemies",
  grouping.gapAfter < grouping.gapBefore && grouping.gapAfter === 1,
  grouping.gapBefore + " -> " + grouping.gapAfter
);
check(
  "    on exactly the tile the preview named",
  grouping.landedOn.x === grouping.promised.x && grouping.landedOn.y === grouping.promised.y,
  JSON.stringify(grouping.landedOn)
);
check("12. a route is legal when it is planned", grouping.plannedLegal);
check(
  "    and gives up when its own shove blocks it",
  grouping.interrupted && /occupied/i.test(grouping.interruptReason || ""),
  grouping.interruptReason
);
check("    naming what stopped it", grouping.blockedBy);
check("    and never puts two frames on one tile", grouping.overlap === false);
check("    with no engine errors", grouping.engineErrors.length === 0, grouping.engineErrors.join(" | "));

/* ---- counterplay ---- */
console.log("counterplay");
const counter = await page.evaluate(`(() => {
  ${PRELUDE}
  // Banking: an activation spent buying manoeuvring power, at a defensive cost.
  const bank = arena(68);
  const spooler = ref(bank, "veteran");
  Z.activateUnitForTest(bank, spooler.id);
  const before = burst(bank, spooler.id).current;
  const cleanEvasion = Z.content.units[spooler.definitionId].baseStats.evasion;
  Z.executeCommand(bank, {
    type: "useAbility",
    unitId: spooler.id,
    abilityId: "spoolDrive",
    target: { unitId: spooler.id, tile: { x: spooler.x, y: spooler.y } }
  });
  const spooled = spooler.statuses.some((entry) => entry.statusId === "spooling");

  // Runway: the same strike is worth a fraction of itself from a standing start.
  const measure = (fromX, distance) => {
    const state = arena(69);
    const mover = ref(state, "veteran");
    const target = ref(state, "clusterA");
    target.x = 14;
    target.y = 8;
    target.currentHp = 9999;
    mover.x = fromX;
    mover.y = 8;
    Z.activateUnitForTest(state, mover.id);
    let input = Z.trajectory.input(state, mover.id, "machStrike");
    input = Z.trajectory.click(state, input, { x: 13, y: 8 }).input;
    input = Z.trajectory.click(state, input, { x: 14, y: 8 }).input;
    Z.executeCommand(state, Z.trajectory.commands(input)[0]);
    return { damage: 9999 - target.currentHp, distance };
  };
  const long = measure(8, 5);
  const short = measure(12, 1);

  // Pinned: a frame with no space genuinely cannot use the route action.
  const boxed = arena(70);
  const pinned = ref(boxed, "veteran");
  const around = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
  ["kell", "vale", "reyes", "clusterA"].forEach((name, index) => {
    const blocker = ref(boxed, name);
    blocker.x = pinned.x + around[index].x;
    blocker.y = pinned.y + around[index].y;
  });

  return {
    banked: burst(bank, spooler.id).current > before,
    exposed: spooled,
    cleanEvasion,
    spooledEvasion: Z.content.units[spooler.definitionId].baseStats.evasion,
    longDamage: long.damage,
    shortDamage: short.damage,
    openRunway: Z.trajectory.hasRunway(boxed, ref(boxed, "kell").id, "machStrike"),
    pinnedRunway: Z.trajectory.hasRunway(boxed, pinned.id, "machStrike"),
    engineErrors: bank.errors.concat(boxed.errors)
  };
})()`);

check("13. an activation can be spent banking manoeuvring power", counter.banked);
check("    which leaves the frame in a worse defensive state", counter.exposed);
check(
  "14. a strike with a run-up is worth markedly more than one without",
  counter.shortDamage * 2 < counter.longDamage,
  counter.shortDamage + " vs " + counter.longDamage
);
check("15. a boxed-in frame has no route to run", counter.pinnedRunway === false);
check("    while one with space still does", counter.openRunway === true);
check("    with no engine errors", counter.engineErrors.length === 0, counter.engineErrors.join(" | "));

/* ---- the route is drawn on the real board ---- */
console.log("board");
const board = await page.evaluate(`(() => {
  ${PRELUDE}
  const state = arena(71);
  const mover = ref(state, "veteran");
  mover.x = 8;
  mover.y = 8;
  Z.activateUnitForTest(state, mover.id);
  let input = Z.trajectory.input(state, mover.id, "vectorRoute");
  for (const tile of [{ x: 11, y: 8 }, { x: 11, y: 5 }]) {
    input = Z.trajectory.click(state, input, tile).input;
  }
  const preview = Z.trajectory.preview(state, input, null);
  return {
    tiles: preview.tiles.length,
    redirectTiles: preview.redirectTiles,
    endpoint: preview.endpoint
  };
})()`);

check("16. the route is a tile list the board can draw", board.tiles === 7, board.tiles);
check(
  "    with its turns marked as turns",
  board.redirectTiles.length === 1 &&
    board.redirectTiles[0].category === "quarter" &&
    board.redirectTiles[0].x === 11 &&
    board.redirectTiles[0].y === 8,
  JSON.stringify(board.redirectTiles)
);

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
await page.getByRole("button", { name: /^Abilities$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /machStrike/ }).first().click();
await page.waitForTimeout(600);
const abilityText = await page.locator("body").innerText();
check("17. a route action opens in the Studio", /Mach Strike/i.test(abilityText));
check("    with its trajectory section", /Trajectory/i.test(abilityText));
await page.getByRole("button", { name: /^Trajectory$/ }).first().click();
await page.waitForTimeout(500);
const trajectoryText = await page.locator("body").innerText();
for (const label of ["Maximum segments", "Permitted turns", "Cost per turn category", "On contact"]) {
  check("    " + label + " is editable", new RegExp(label, "i").test(trajectoryText));
}

const authoring = await page.evaluate(async () => {
  const registry = await import("/src/content/gameplay/registry.js");
  const validate = await import("/src/content/gameplay/validate.js");
  const draft = JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));
  draft.abilities.machStrike.trajectory.allowedRedirects = ["quarter", "pirouette"];
  const broken = validate.validateGameplayData(draft);

  const priced = JSON.parse(JSON.stringify(registry.CANONICAL_GAMEPLAY));
  delete priced.abilities.machStrike.trajectory.resourceId;
  return {
    clean: validate.validateGameplayData(registry.CANONICAL_GAMEPLAY).errors.length,
    unknownTurn: broken.errors.some((message) => /pirouette/.test(message)),
    unpaid: validate.validateGameplayData(priced).ok === false,
    runningMaxSegments: window.STATUS_ZERO.content.abilities.machStrike.trajectory.maxSegments
  };
});
check("18. the shipped data validates", authoring.clean === 0, authoring.clean);
check("    a turn category the planner has never heard of is refused", authoring.unknownTurn);
check("    and prices with nothing to pay them in are refused", authoring.unpaid);
check("    while the running content is untouched", authoring.runningMaxSegments === 2);

await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("19. the editor still returns to the main menu", /NEW GAME/i.test(await page.locator("body").innerText()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((entry) => entry.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
