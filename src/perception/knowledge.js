/* =========================================================================
 * FACTION-SCOPED BATTLEFIELD KNOWLEDGE
 *
 * What a faction *believes* about a unit, as opposed to what is true.
 *
 *   unseen     no usable information — the unit does not exist as far as this
 *              faction's decision-making is concerned
 *   suspected  a contact: something is or was around here. Enough to move
 *              toward, search, or take cover from. Never enough to shoot.
 *   acquired   a firing solution: this faction can act on the real tile
 *
 * Records are keyed by faction, never by unit, because knowledge is a
 * *faction* asset — that is what makes "two hostile factions hold different
 * beliefs about the same physical unit" fall out for free rather than needing
 * a special case.
 *
 * Everything here is plain serializable data operated on by pure functions.
 * No engine imports, no React, no timers: decay is measured in activations.
 * =======================================================================*/

import {
  KNOWLEDGE_STATES,
  KNOWLEDGE_RANK,
  rankOf,
  channelDefinition,
  isKnowledgeState
} from "./channels.js";

export const PERCEPTION_VERSION = 1;

/**
 * Every duration here is counted in *the believing faction's own activations*,
 * not global ones and certainly not seconds. "Three activations" has to mean
 * three of my turns, or a twelve-unit battle would forget everything between
 * one of my units acting and the next.
 */
export const DEFAULT_PERCEPTION_CONFIG = {
  /** Own-faction activations a stale SUSPECTED contact survives. */
  suspectedDecayActivations: 4,
  /** Distance at which standing near a last-known tile counts as searching it. */
  searchArrivalRadius: 1,
  /** A contact whose last-known tile was searched and found empty decays faster. */
  investigatedDecayActivations: 1,
  /**
   * Own-faction activations of *total* blindness before a reconnaissance sweep
   * hands the faction fresh contacts.
   *
   * Fog of war has one failure mode that is not interesting: two sides that
   * cannot find each other and stand still until the activation cap. This is
   * the escalation that resolves it — command notices you have lost the enemy
   * entirely and tells you roughly where they are.
   *
   * It grants SUSPECTED only, so nothing becomes targetable, and it goes stale
   * like any other contact. It fires only when a faction knows *nothing* at
   * all, which in an ordinary battle never happens. Set to 0 to disable.
   */
  reconSweepActivations: 12,
  /** Hard ceiling so a pathological mission cannot grow knowledge without bound. */
  maxRecordsPerFaction: 4096
};

/* ---------------------------------------------------------------
 * STORE
 * -------------------------------------------------------------*/

export function createPerceptionState(factionIds, options) {
  const config = { ...DEFAULT_PERCEPTION_CONFIG, ...(options && options.config) };
  const factions = {};
  for (const factionId of factionIds || []) factions[factionId] = newFaction();
  return {
    version: PERCEPTION_VERSION,
    enabled: options && options.enabled === false ? false : true,
    config,
    factions,
    /** Monotonic counter so a caller can cheaply detect "did anything change?" */
    revision: 0
  };
}

function newFaction() {
  return {
    units: {},
    /** This faction's own activation counter — the clock every duration uses. */
    clock: 0,
    /** Consecutive own activations with no contact of any kind, anywhere. */
    blindFor: 0,
    /**
     * Where to look when nothing is known at all.
     *
     * Seeded at battle start with the centre of the hostile deployment, which
     * is legitimate: you were dropped here to fight them and you know which
     * way they came from. Updated to a contact's last-known tile whenever one
     * is finally forgotten, so "sweep the area where he vanished" is the
     * standing behaviour rather than a special mode.
     *
     * It is an *area*, never a unit. Nothing can be targeted through it.
     */
    searchAnchor: null
  };
}

export function ensureFactionKnowledge(perception, factionId) {
  if (!perception.factions[factionId]) perception.factions[factionId] = newFaction();
  const faction = perception.factions[factionId];
  if (faction.clock == null) faction.clock = 0;
  if (faction.blindFor == null) faction.blindFor = 0;
  if (faction.searchAnchor === undefined) faction.searchAnchor = null;
  return faction;
}

/** True when this faction holds no contact of any kind on anyone. */
export function factionIsBlind(perception, factionId) {
  const faction = perception && perception.factions[factionId];
  if (!faction) return true;
  for (const unitId of Object.keys(faction.units)) {
    if (faction.units[unitId].state !== "unseen") return false;
  }
  return true;
}

export function factionClock(perception, factionId) {
  const faction = perception && perception.factions[factionId];
  return faction ? faction.clock || 0 : 0;
}

export function advanceFactionClock(perception, factionId) {
  const faction = ensureFactionKnowledge(perception, factionId);
  faction.clock += 1;
  return faction.clock;
}

export function setSearchAnchor(perception, factionId, tile) {
  const faction = ensureFactionKnowledge(perception, factionId);
  if (!tile || tile.x == null || tile.y == null) return false;
  const previous = faction.searchAnchor;
  if (previous && previous.x === tile.x && previous.y === tile.y) return false;
  faction.searchAnchor = { x: tile.x, y: tile.y };
  perception.revision += 1;
  return true;
}

export function searchAnchorOf(perception, factionId) {
  const faction = perception && perception.factions[factionId];
  return (faction && faction.searchAnchor) || null;
}

export function factionIdsIn(perception) {
  return Object.keys(perception.factions).sort();
}

/* ---------------------------------------------------------------
 * RECORDS
 * -------------------------------------------------------------*/

/**
 * @typedef {Object} KnowledgeRecord
 * @property {string} unitId
 * @property {"unseen"|"suspected"|"acquired"} state
 * @property {number|null} x    Believed position. Null at `unseen`.
 * @property {number|null} y
 * @property {"exact"|"approximate"|"none"} accuracy
 * @property {string[]} channels        Channels that produced the current state.
 * @property {number} updatedActivation Activation index of the last change.
 * @property {number} positionActivation Activation index the position dates from.
 * @property {number|null} firstSeenActivation
 * @property {boolean} investigated     The last-known tile was searched and was empty.
 * @property {string} source            sensor | intel | script | share
 */

function blankRecord(unitId, activation) {
  return {
    unitId,
    state: "unseen",
    x: null,
    y: null,
    accuracy: "none",
    channels: [],
    updatedActivation: activation,
    positionActivation: activation,
    firstSeenActivation: null,
    investigated: false,
    /**
     * A briefed fact rather than an observation, so decay leaves it alone.
     *
     * "The containers are in the north yard" does not stop being true because
     * nobody has looked at them lately. It is still only SUSPECTED — it cannot
     * be shot at, and a unit that has moved since the briefing has made it
     * wrong, which is exactly the right failure mode.
     */
    persistent: false,
    source: "sensor"
  };
}

export function knowledgeOf(perception, factionId, unitId) {
  if (!perception || !perception.factions[factionId]) return null;
  return perception.factions[factionId].units[unitId] || null;
}

export function knowledgeStateOf(perception, factionId, unitId) {
  const record = knowledgeOf(perception, factionId, unitId);
  return record ? record.state : "unseen";
}

export function knowsUnit(perception, factionId, unitId) {
  return rankOf(knowledgeStateOf(perception, factionId, unitId)) >= KNOWLEDGE_RANK.acquired;
}

export function hasContact(perception, factionId, unitId) {
  return rankOf(knowledgeStateOf(perception, factionId, unitId)) >= KNOWLEDGE_RANK.suspected;
}

/**
 * The position a faction is entitled to act on, or null.
 *
 * This is the single function AI decision-making is allowed to call. It never
 * consults the unit's real coordinates — it reads the record, which is the
 * only place a believed position exists.
 */
export function believedPosition(perception, factionId, unitId) {
  const record = knowledgeOf(perception, factionId, unitId);
  if (!record || record.state === "unseen") return null;
  if (record.x == null || record.y == null) return null;
  return { x: record.x, y: record.y, accuracy: record.accuracy, state: record.state };
}

function ensureRecord(perception, factionId, unitId, activation) {
  const faction = ensureFactionKnowledge(perception, factionId);
  let record = faction.units[unitId];
  if (!record) {
    const count = Object.keys(faction.units).length;
    if (count >= perception.config.maxRecordsPerFaction) return null;
    record = blankRecord(unitId, activation);
    faction.units[unitId] = record;
  }
  return record;
}

/* ---------------------------------------------------------------
 * TRANSITIONS
 * -------------------------------------------------------------*/

/**
 * Applies one observation.
 *
 * An observation never downgrades a record: losing a contact is decay's job,
 * and a weak channel firing while a strong one is live must not blind anyone.
 * Returns null when nothing changed, so callers can emit an event only on a
 * real transition.
 */
export function applyObservation(perception, factionId, observation, activation) {
  const record = ensureRecord(perception, factionId, observation.unitId, activation);
  if (!record) return null;

  const channel = channelDefinition(observation.channel);
  const ceiling = observation.maxState || (channel ? channel.maxState : "suspected");
  let next = observation.state || ceiling;
  if (!isKnowledgeState(next)) next = "suspected";
  if (rankOf(next) > rankOf(ceiling)) next = ceiling;

  const previousState = record.state;
  const previousX = record.x;
  const previousY = record.y;
  const upgrading = rankOf(next) >= rankOf(previousState);
  if (!upgrading) return null;

  const accuracy =
    observation.accuracy || (channel ? channel.accuracy : "approximate");

  // An approximate channel must not overwrite a better fix taken this same
  // activation — hearing a shot should not blur a target you can see.
  const keepBetterFix =
    accuracy === "approximate" &&
    record.accuracy === "exact" &&
    record.positionActivation === activation &&
    rankOf(next) <= rankOf(previousState);

  if (!keepBetterFix && observation.x != null && observation.y != null) {
    record.x = observation.x;
    record.y = observation.y;
    record.accuracy = accuracy;
    record.positionActivation = activation;
    record.investigated = false;
  }

  record.state = next;
  // The moment a sensor takes over, the record stops being a briefing and
  // becomes an observation — with an observation's shelf life.
  record.persistent = false;
  record.source = observation.source || "sensor";
  record.channels = observation.channels
    ? observation.channels.slice().sort()
    : [observation.channel].filter(Boolean);
  record.updatedActivation = activation;
  if (record.firstSeenActivation == null && rankOf(next) >= KNOWLEDGE_RANK.acquired) {
    record.firstSeenActivation = activation;
  }

  const moved = record.x !== previousX || record.y !== previousY;
  if (previousState === next && !moved) return null;

  perception.revision += 1;
  return { unitId: observation.unitId, factionId, from: previousState, to: next, record, moved };
}

/**
 * Demotes a record one step, keeping what is still meaningful.
 *
 * acquired → suspected keeps the last-known tile: that is precisely the
 * "he was right there a second ago" information a searching unit needs.
 * suspected → unseen throws the position away, because a stale guess that is
 * allowed to persist forever is just omniscience with extra steps.
 */
export function demoteKnowledge(perception, factionId, unitId, activation, reason) {
  const record = knowledgeOf(perception, factionId, unitId);
  if (!record || record.state === "unseen") return null;

  const from = record.state;
  const to = KNOWLEDGE_STATES[Math.max(0, rankOf(from) - 1)];
  const lastKnown = record.x == null ? null : { x: record.x, y: record.y };
  record.state = to;
  record.updatedActivation = activation;
  record.source = reason || "decay";
  if (to === "unseen") {
    record.x = null;
    record.y = null;
    record.accuracy = "none";
    record.channels = [];
    record.investigated = false;
  } else {
    record.accuracy = record.accuracy === "exact" ? "exact" : "approximate";
    record.channels = [];
  }

  perception.revision += 1;
  return { unitId, factionId, from, to, record, lastKnown, reason: reason || "decay" };
}

/** Direct authored write: mission scripting, intel handovers, debug tooling. */
export function setKnowledge(perception, factionId, unitId, next, options) {
  const activation = (options && options.activation) || 0;
  const record = ensureRecord(perception, factionId, unitId, activation);
  if (!record) return null;
  if (!isKnowledgeState(next)) return null;

  const from = record.state;
  const previousX = record.x;
  const previousY = record.y;

  record.state = next;
  record.updatedActivation = activation;
  record.source = (options && options.source) || "script";
  record.channels = (options && options.channels) || ["intel"];
  record.persistent = !!(options && options.persistent);

  if (next === "unseen") {
    record.x = null;
    record.y = null;
    record.accuracy = "none";
    record.channels = [];
    record.investigated = false;
    record.persistent = false;
  } else if (options && options.x != null && options.y != null) {
    record.x = options.x;
    record.y = options.y;
    record.accuracy = (options && options.accuracy) || (next === "acquired" ? "exact" : "approximate");
    record.positionActivation = activation;
    record.investigated = false;
  }
  if (next === "acquired" && record.firstSeenActivation == null) {
    record.firstSeenActivation = activation;
  }

  const moved = record.x !== previousX || record.y !== previousY;
  if (from === next && !moved) return null;
  perception.revision += 1;
  return { unitId, factionId, from, to: next, record, moved };
}

export function clearKnowledge(perception, factionId, unitId, activation) {
  return setKnowledge(perception, factionId, unitId, "unseen", { activation, source: "script" });
}

/** Marks a last-known tile as searched, so decay can retire a dead lead. */
export function markInvestigated(perception, factionId, unitId, activation) {
  const record = knowledgeOf(perception, factionId, unitId);
  if (!record || record.state !== "suspected" || record.investigated) return false;
  record.investigated = true;
  record.updatedActivation = activation;
  perception.revision += 1;
  return true;
}

/**
 * Decay pass for one faction.
 *
 * Purely a function of activation indices, so a replay from the same seed
 * decays at exactly the same moments and a save taken mid-search reloads with
 * the same amount of leash left.
 */
export function decayFaction(perception, factionId, activation, observedIds) {
  const faction = perception.factions[factionId];
  if (!faction) return [];
  const observed = observedIds || new Set();
  const changes = [];

  for (const unitId of Object.keys(faction.units).sort()) {
    const record = faction.units[unitId];
    if (record.state === "unseen") continue;
    if (observed.has(unitId)) continue;
    // A briefing is not an observation and does not go stale on its own.
    if (record.persistent && record.state === "suspected") continue;

    if (record.state === "acquired") {
      // The instant a firing solution is not being maintained it degrades to a
      // last-known contact. This is the whole of "contact lost".
      const change = demoteKnowledge(perception, factionId, unitId, activation, "contactLost");
      if (change) changes.push(change);
      continue;
    }

    const limit = record.investigated
      ? perception.config.investigatedDecayActivations
      : perception.config.suspectedDecayActivations;
    if (activation - record.updatedActivation >= limit) {
      const change = demoteKnowledge(perception, factionId, unitId, activation, "decayed");
      if (change) changes.push(change);
    }
  }
  return changes;
}

/* ---------------------------------------------------------------
 * SHARING
 * -------------------------------------------------------------*/

/**
 * Explicit handover of knowledge between factions.
 *
 * Never implicit. A unit changing sides does not hand its faction's map over,
 * because the record lives with the faction rather than the unit — a defection
 * that should come with intel is a scripted `shareKnowledge`, which is exactly
 * the beat an author wants control over.
 */
export function shareKnowledge(perception, fromFactionId, toFactionId, options) {
  const source = perception.factions[fromFactionId];
  if (!source || fromFactionId === toFactionId) return [];
  const activation = (options && options.activation) || 0;
  const ceiling = (options && options.maxState) || "acquired";
  const only = options && options.unitIds ? new Set(options.unitIds) : null;
  const changes = [];

  for (const unitId of Object.keys(source.units).sort()) {
    if (only && !only.has(unitId)) continue;
    const record = source.units[unitId];
    if (record.state === "unseen") continue;
    let next = record.state;
    if (rankOf(next) > rankOf(ceiling)) next = ceiling;
    const change = setKnowledge(perception, toFactionId, unitId, next, {
      activation,
      x: record.x,
      y: record.y,
      accuracy: next === "acquired" ? record.accuracy : "approximate",
      channels: ["intel"],
      source: "share"
    });
    if (change) changes.push(change);
  }
  return changes;
}

/* ---------------------------------------------------------------
 * INSPECTION
 * -------------------------------------------------------------*/

export function describeFactionKnowledge(perception, factionId) {
  const faction = perception.factions[factionId];
  if (!faction) return [];
  return Object.keys(faction.units)
    .sort()
    .map((unitId) => ({ ...faction.units[unitId] }))
    .filter((record) => record.state !== "unseen");
}

export function countKnowledge(perception, factionId, state) {
  const faction = perception.factions[factionId];
  if (!faction) return 0;
  let total = 0;
  for (const unitId of Object.keys(faction.units)) {
    if (faction.units[unitId].state === state) total += 1;
  }
  return total;
}
