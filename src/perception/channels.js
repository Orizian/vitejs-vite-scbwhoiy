/* =========================================================================
 * OBSERVATION CHANNELS
 *
 * The vocabulary of *how* a faction can come to know something. A channel is
 * data, not code: it says what physics it obeys (does it need line of sight?
 * does terrain stop it?), how precise the position it yields is, and how far
 * up the knowledge ladder it can push a contact on its own.
 *
 * This is deliberately the whole of the sensory model for now. Nyx's Heat,
 * cloak falloff and the counter-stealth equipment tier all become *emitters*
 * and *sensor profiles* expressed in these channels — none of them needs a new
 * channel or a change here.
 *
 * Pure data. No engine imports, so the editor can validate against it.
 * =======================================================================*/

/**
 * @typedef {Object} ObservationChannel
 * @property {string} id
 * @property {string} label
 * @property {boolean} requiresLineOfSight  Terrain that blocks LOS blocks this.
 * @property {boolean} piercesConcealment   Ignores `untargetable`/`hidden` statuses.
 * @property {"exact"|"approximate"|"none"} accuracy  Quality of the position it yields.
 * @property {number} maxState              The highest knowledge state it can reach alone.
 */

export const KNOWLEDGE_STATES = ["unseen", "suspected", "acquired"];

/** Numeric rank so "is this better than what we had?" is a comparison. */
export const KNOWLEDGE_RANK = { unseen: 0, suspected: 1, acquired: 2 };

export function rankOf(state) {
  return KNOWLEDGE_RANK[state] == null ? 0 : KNOWLEDGE_RANK[state];
}

export function stateAtRank(rank) {
  return KNOWLEDGE_STATES[Math.max(0, Math.min(KNOWLEDGE_STATES.length - 1, rank))];
}

export const OBSERVATION_CHANNELS = {
  optical: {
    id: "optical",
    label: "Optical",
    description: "Eyes and cameras. Needs a clear line; defeated by concealment.",
    requiresLineOfSight: true,
    piercesConcealment: false,
    accuracy: "exact",
    maxState: "acquired"
  },

  thermal: {
    id: "thermal",
    label: "Thermal",
    description:
      "Heat signature. Sees through visual concealment but not through walls, " +
      "and is confused by ambient heat.",
    requiresLineOfSight: true,
    piercesConcealment: true,
    accuracy: "exact",
    maxState: "acquired"
  },

  signal: {
    id: "signal",
    label: "Signal",
    description:
      "EM and comms emissions. Ignores terrain but gives a bearing, not a tile — " +
      "enough to suspect, never enough to shoot.",
    requiresLineOfSight: false,
    piercesConcealment: true,
    accuracy: "approximate",
    maxState: "suspected"
  },

  acoustic: {
    id: "acoustic",
    label: "Acoustic",
    description:
      "Gunfire, footfalls, a door forced open. Ignores terrain, degrades with " +
      "distance, and only ever produces a contact to investigate.",
    requiresLineOfSight: false,
    piercesConcealment: true,
    accuracy: "approximate",
    maxState: "suspected"
  },

  intel: {
    id: "intel",
    label: "Intel",
    description:
      "Knowledge that did not come from a sensor: a mission briefing, an ally's " +
      "report, a defector's handover. Obeys no physics because it is not physics.",
    requiresLineOfSight: false,
    piercesConcealment: true,
    accuracy: "exact",
    maxState: "acquired"
  }
};

export const CHANNEL_IDS = Object.keys(OBSERVATION_CHANNELS);

export function channelDefinition(channelId) {
  return OBSERVATION_CHANNELS[channelId] || null;
}

export function isKnowledgeState(value) {
  return KNOWLEDGE_STATES.includes(value);
}

/**
 * The default sensor profile.
 *
 * `optical` at a range that covers any authored map is what preserves the old
 * behaviour on an open field: everything in the clear is acquired, and only
 * terrain and concealment take it away. Content narrows this per chassis when
 * a design calls for it; nothing in the engine assumes these numbers.
 */
export const DEFAULT_SENSOR_PROFILE = {
  channels: {
    optical: { range: 64 },
    acoustic: { range: 12 },
    signal: { range: 0 },
    thermal: { range: 0 },
    intel: { range: 0 }
  }
};

/**
 * The default emission profile: what a unit gives off, per channel.
 *
 * A number is a multiplier on the observer's range for that channel. 1 is
 * "an ordinary body". A cloak is a chassis or status that pushes `optical`
 * toward 0 while leaving `thermal` alone — which is exactly the shape Nyx's
 * kit needs, and why no cloak-specific concept appears anywhere in here.
 */
export const DEFAULT_EMISSION_PROFILE = {
  optical: 1,
  thermal: 1,
  signal: 0,
  acoustic: 0
};

/** Channels ordered for deterministic iteration and stable log output. */
export const CHANNEL_ORDER = ["optical", "thermal", "signal", "acoustic", "intel"];
