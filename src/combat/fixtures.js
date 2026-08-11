/* =========================================================================
 * BATTLEFIELD FIXTURES
 *
 * Something that sits on a tile, belongs to somebody, remembers what state it
 * is in, and is not a unit.
 *
 * The engine had two ways to put something on the map and neither fit:
 *
 *   a unit          occupies its tile, has health, takes turns, can be
 *                   targeted by everything, and shows up in the timeline
 *   a terrain
 *   override        has no owner, no state, no trigger and no lifecycle
 *
 * A mine is neither. It belongs to a faction, sits on a tile without blocking
 * it, is armed or not, is known to one side and not the other, and disappears
 * when it goes off. So does a beacon, a deployable shield node, a healing
 * station, a rune and a turret emplacement — which is the argument for one
 * generic concept rather than a trap system.
 *
 * What this module owns: the shape of an instance, the state machine it moves
 * through, and a deterministic collection with the operations that collection
 * needs. What it deliberately does not own: what a fixture *does*. Triggers
 * and effects are authored, and resolving them is the engine's ordinary
 * pipeline, not something here.
 *
 * Pure data and pure functions. No engine imports, no React, no content ids.
 * =======================================================================*/

import { regionContains, createTileIndex, tileKeyOf } from "../mission/regions.js";

/* ---------------------------------------------------------------
 * STATE
 *
 * Small and closed on purpose. A fixture that could be in any state an author
 * invented would need a state-machine language to describe, and every system
 * that reads fixtures would have to cope with states it had never heard of.
 * Five is enough for a mine, a charge, a beacon and a deployable, and the
 * transitions between them are the ones that mean something mechanically.
 * -------------------------------------------------------------*/

export const FIXTURE_STATES = ["placed", "armed", "triggered", "disarmed", "removed"];

/** Which states may follow which. Anything not listed is refused. */
const TRANSITIONS = {
  placed: ["armed", "disarmed", "removed", "triggered"],
  armed: ["triggered", "disarmed", "removed"],
  triggered: ["armed", "removed"],
  disarmed: ["armed", "removed"],
  removed: []
};

export function canTransition(from, to) {
  if (!FIXTURE_STATES.includes(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/** A fixture in a state where it can still do its job. */
export function isActive(fixture) {
  return !!fixture && fixture.state !== "removed" && fixture.state !== "triggered";
}

/** A fixture that will respond to something entering its tile. */
export function isArmed(fixture) {
  return !!fixture && fixture.state === "armed";
}

/* ---------------------------------------------------------------
 * VISIBILITY
 *
 * Who knows a fixture is there. Deliberately a small closed vocabulary rather
 * than a per-faction knowledge model: a mine either announces itself, or it is
 * a secret its owners keep, or it has been found. Detection sophistication is
 * the perception layer's job if it is ever wanted, and this leaves room for it
 * without pretending to have it.
 * -------------------------------------------------------------*/

export const FIXTURE_VISIBILITY = ["everyone", "ownerTeam", "ownerOnly"];

/**
 * Whether a faction can see a fixture.
 *
 * `revealed` overrides the authored setting in one direction only: once
 * something has been found it stays found. Nothing here can make a visible
 * fixture secret again, because that is how a player ends up standing on a
 * mine they were previously shown.
 */
export function fixtureVisibleTo(fixture, teamId, options) {
  if (!fixture) return false;
  const opts = options || {};
  if (fixture.revealed) return true;
  if (fixture.ownerTeamId && teamId && fixture.ownerTeamId === teamId) return true;
  switch (fixture.visibility) {
    case "everyone":
      return true;
    case "ownerOnly":
      return !!(opts.unitId && fixture.ownerUnitId && opts.unitId === fixture.ownerUnitId);
    case "ownerTeam":
    default:
      return false;
  }
}

/* ---------------------------------------------------------------
 * THE COLLECTION
 * -------------------------------------------------------------*/

export function createFixtureState() {
  return {
    /** Insertion-ordered, so iteration and serialization are deterministic. */
    order: [],
    byId: {},
    nextId: 1
  };
}

/**
 * Places a fixture.
 *
 * `definitionId` names authored data this module never reads. `state` is what
 * the definition said to start in, validated against the closed list, because
 * a typo that produced an unknown state would otherwise sit inert on the map
 * looking exactly like a working mine.
 */
export function createFixture(collection, options) {
  const opts = options || {};
  const id = "fx" + collection.nextId;
  collection.nextId += 1;
  const requested = opts.state || "placed";
  const fixture = {
    id,
    definitionId: opts.definitionId || null,
    x: opts.x,
    y: opts.y,
    ownerTeamId: opts.ownerTeamId || null,
    ownerUnitId: opts.ownerUnitId || null,
    createdBy: opts.createdBy || opts.ownerUnitId || null,
    state: FIXTURE_STATES.includes(requested) ? requested : "placed",
    visibility: FIXTURE_VISIBILITY.includes(opts.visibility) ? opts.visibility : "ownerTeam",
    revealed: opts.revealed === true,
    blocksMovement: opts.blocksMovement === true,
    /** Remaining activations. Null means "no limit an author cared about". */
    charges: opts.charges == null ? null : Math.max(0, Math.floor(opts.charges)),
    consumedOnTrigger: opts.consumedOnTrigger !== false,
    /** Tiles beyond the anchor that also trigger it, if the author wanted any. */
    triggerTiles: (opts.triggerTiles || []).map((tile) => ({ x: tile.x, y: tile.y })),
    /** A small authored bag for definition-specific numbers. Never code. */
    data: opts.data ? { ...opts.data } : {},
    createdAt: opts.createdAt == null ? null : opts.createdAt
  };
  collection.byId[id] = fixture;
  collection.order.push(id);
  return fixture;
}

export function findFixture(collection, fixtureId) {
  if (!collection || !fixtureId) return null;
  return collection.byId[fixtureId] || null;
}

/** Every fixture, in placement order. Removed ones are gone, not filtered. */
export function allFixtures(collection) {
  if (!collection) return [];
  return collection.order.map((id) => collection.byId[id]).filter(Boolean);
}

/**
 * Fixtures whose anchor or trigger area covers a tile.
 *
 * Linear over the collection. At the counts a battle actually holds — tens,
 * not thousands — an index costs more in bookkeeping than it saves, and the
 * measured cost of a scan is far below the movement it is attached to. If that
 * stops being true the fix is a tile index built here, with no caller changing.
 */
export function fixturesAtTile(collection, x, y, filter) {
  const out = [];
  for (const fixture of allFixtures(collection)) {
    if (!coversTile(fixture, x, y)) continue;
    if (filter && !filter(fixture)) continue;
    out.push(fixture);
  }
  return out;
}

export function coversTile(fixture, x, y) {
  if (!fixture) return false;
  if (fixture.x === x && fixture.y === y) return true;
  return regionContains(fixture.triggerTiles, x, y);
}

/** Every tile a fixture responds to, anchor first. */
export function fixtureTiles(fixture) {
  const tiles = [{ x: fixture.x, y: fixture.y }];
  for (const tile of fixture.triggerTiles || []) {
    if (tile.x === fixture.x && tile.y === fixture.y) continue;
    tiles.push({ x: tile.x, y: tile.y });
  }
  return tiles;
}

/**
 * The first tile of a path that a fixture responds to, and where in the path.
 *
 * A mover crossing a mined tile mid-route has to set it off *there*, not on
 * arrival, so this reports the index as well as the tile. Returns null when
 * the path never touches the fixture.
 */
export function pathContact(fixture, path) {
  const index = createTileIndex(fixtureTiles(fixture));
  const steps = path || [];
  for (let step = 0; step < steps.length; step += 1) {
    if (index.has(tileKeyOf(steps[step].x, steps[step].y))) {
      return { index: step, tile: { x: steps[step].x, y: steps[step].y } };
    }
  }
  return null;
}

/* ---------------------------------------------------------------
 * MUTATION
 *
 * Every one of these returns what actually happened rather than throwing or
 * silently succeeding, because a caller that asked to arm something already
 * removed needs to be able to say so in a log line.
 * -------------------------------------------------------------*/

export function setFixtureState(collection, fixtureId, next) {
  const fixture = findFixture(collection, fixtureId);
  if (!fixture) return { ok: false, reason: "no such fixture" };
  if (fixture.state === next) return { ok: true, fixture, changed: false, from: next };
  if (!canTransition(fixture.state, next)) {
    return {
      ok: false,
      fixture,
      reason: "cannot go from " + fixture.state + " to " + next
    };
  }
  const from = fixture.state;
  fixture.state = next;
  return { ok: true, fixture, changed: true, from };
}

export function armFixture(collection, fixtureId) {
  return setFixtureState(collection, fixtureId, "armed");
}

export function disarmFixture(collection, fixtureId) {
  return setFixtureState(collection, fixtureId, "disarmed");
}

/**
 * Spends one activation.
 *
 * A fixture with charges left goes back to armed and stays on the map; one
 * without is consumed if its definition said so, and otherwise sits spent.
 * The distinction is what separates a mine from a turret emplacement, and it
 * is authored rather than decided here.
 */
export function consumeFixtureCharge(collection, fixtureId) {
  const fixture = findFixture(collection, fixtureId);
  if (!fixture) return { ok: false, reason: "no such fixture" };
  if (fixture.charges != null) fixture.charges = Math.max(0, fixture.charges - 1);
  const spent = fixture.charges != null && fixture.charges <= 0;
  const exhausted = fixture.charges == null || spent;

  if (!exhausted) {
    fixture.state = "armed";
    return { ok: true, fixture, remaining: fixture.charges, consumed: false, rearmed: true };
  }
  if (fixture.consumedOnTrigger) {
    fixture.state = "removed";
    return { ok: true, fixture, remaining: 0, consumed: true, rearmed: false };
  }
  fixture.state = "triggered";
  return { ok: true, fixture, remaining: fixture.charges, consumed: false, rearmed: false };
}

/** Takes a fixture off the board for good. */
export function removeFixture(collection, fixtureId) {
  const fixture = findFixture(collection, fixtureId);
  if (!fixture) return { ok: false, reason: "no such fixture" };
  fixture.state = "removed";
  delete collection.byId[fixtureId];
  const at = collection.order.indexOf(fixtureId);
  if (at >= 0) collection.order.splice(at, 1);
  return { ok: true, fixture };
}

/** Drops everything already removed. Ordinary housekeeping, order preserved. */
export function pruneFixtures(collection) {
  const dead = allFixtures(collection).filter((fixture) => fixture.state === "removed");
  for (const fixture of dead) removeFixture(collection, fixture.id);
  return dead.length;
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 *
 * Plain data all the way down, so a save is a copy and a replay reproduces it.
 * `nextId` travels with the collection: reusing an id after a reload would
 * make two different fixtures indistinguishable in a causal trace.
 * -------------------------------------------------------------*/

export function serializeFixtures(collection) {
  return JSON.parse(JSON.stringify(collection || createFixtureState()));
}

export function deserializeFixtures(raw) {
  const base = createFixtureState();
  if (!raw || typeof raw !== "object") return base;
  base.order = Array.isArray(raw.order) ? raw.order.slice() : [];
  base.byId = {};
  for (const id of base.order) {
    const stored = raw.byId ? raw.byId[id] : null;
    if (stored) base.byId[id] = { ...stored, triggerTiles: (stored.triggerTiles || []).slice() };
  }
  base.order = base.order.filter((id) => !!base.byId[id]);
  base.nextId = Number(raw.nextId) > 0 ? Number(raw.nextId) : base.order.length + 1;
  return base;
}

/** A one-line description for a log or a panel. */
export function describeFixture(fixture) {
  if (!fixture) return "";
  return (
    fixture.definitionId +
    " at " + fixture.x + "," + fixture.y +
    " (" + fixture.state +
    (fixture.charges == null ? "" : ", " + fixture.charges + " left") +
    ")"
  );
}
