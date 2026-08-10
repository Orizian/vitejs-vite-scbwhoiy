/* =========================================================================
 * STATUS ZERO — GAMEPLAY DATA FORMAT
 *
 * The canonical shape of authored gameplay data, and the one serializer that
 * writes it.
 *
 * Everything the Studio edits lives in `src/content/gameplay/*.json`. Those
 * files are the game's actual input — not an editor-side mirror — which is the
 * property that makes "export changes, hand the bundle to Claude" a mechanical
 * operation rather than an act of reverse engineering.
 *
 * This module is used three times over, deliberately:
 *
 *   1. the migration that first extracted these files out of App.jsx
 *   2. the registry that loads them at runtime
 *   3. the Studio's export
 *
 * Because all three go through `serializeRegistryFile`, a file on disk and the
 * file the Studio exports for unmodified data are byte-identical. That is what
 * lets dirty-tracking mean "semantically changed" instead of "re-serialized".
 *
 * Pure data and pure functions. No React, no engine, no editor state.
 * =======================================================================*/

export const GAMEPLAY_FORMAT_ID = "statuszero.gameplay";
export const GAMEPLAY_FORMAT_VERSION = 1;

/**
 * Every authored gameplay registry, and where it canonically lives.
 *
 * `path` is repository-relative and is what an export bundle mirrors, so a
 * bundle says exactly which file each entity belongs to.
 *
 * `fieldOrder` fixes key order inside an entity. Anything not listed follows,
 * alphabetically, so a field this build has never heard of still round-trips
 * and still lands in a stable place.
 */
export const REGISTRY_KINDS = {
  units: {
    id: "units",
    label: "Units",
    singular: "unit",
    path: "src/content/gameplay/units.json",
    summary:
      "Combat unit definitions — the frame. Durability, mobility, sensors, " +
      "emissions, native abilities and art. Both a player chassis and an enemy " +
      "archetype are entries here; nothing distinguishes them but usage.",
    fieldOrder: [
      "name",
      "classId",
      "role",
      "glyph",
      "description",
      "tags",
      "baseStats",
      "resources",
      "abilities",
      "defaultAbilityId",
      "aiProfile",
      "perception",
      "defaultEquipment",
      "assets"
    ]
  },
  abilities: {
    id: "abilities",
    label: "Abilities",
    singular: "ability",
    path: "src/content/gameplay/abilities.json",
    summary:
      "What a unit can do. Targeting, timing, costs, conditions and the ordered " +
      "effect list the engine resolves.",
    fieldOrder: [
      "name",
      "description",
      "activation",
      "targeting",
      "timing",
      "costs",
      "conditions",
      "effects",
      "tags",
      "ui",
      "assets"
    ]
  },
  equipment: {
    id: "equipment",
    label: "Equipment",
    singular: "equipment",
    path: "src/content/gameplay/equipment.json",
    summary:
      "Installed technology: weapons, armour, utility and core systems. Weapons " +
      "are equipment with a weapon slot rather than a separate registry.",
    fieldOrder: [
      "name",
      "slot",
      "description",
      "compatibleClasses",
      "tags",
      "modifiers",
      "perception",
      "grantsAbilities",
      "removesAbilities",
      "assets"
    ]
  },
  statuses: {
    id: "statuses",
    label: "Statuses",
    singular: "status",
    path: "src/content/gameplay/statuses.json",
    summary:
      "Timed conditions. The parameters are authored; several flags select " +
      "engine behaviour rather than defining it.",
    fieldOrder: [
      "name",
      "category",
      "glyph",
      "description",
      "tags",
      "duration",
      "modifiers",
      "triggers",
      "preventsAction",
      "untargetable",
      "hidden",
      "removedOnHostileAction",
      "perception",
      "assets"
    ]
  },
  aiProfiles: {
    id: "aiProfiles",
    label: "AI profiles",
    singular: "AI profile",
    path: "src/content/gameplay/ai-profiles.json",
    summary:
      "Weight vectors the scoring AI uses. Not behaviour trees — the behaviour " +
      "is engine code; these are its priorities.",
    fieldOrder: []
  },
  operators: {
    id: "operators",
    label: "Operators",
    singular: "operator",
    path: "src/content/gameplay/operators.json",
    summary:
      "Playable pilots. An operator owns identity and progression and points at " +
      "a chassis; it does not own the chassis's stats.",
    fieldOrder: ["name", "ref", "glyph", "role", "chassis", "recruit", "perkChoices"]
  },
  perks: {
    id: "perks",
    label: "Perks",
    singular: "perk",
    path: "src/content/gameplay/perks.json",
    summary: "Per-operator progression choices, applied as stat modifiers.",
    fieldOrder: ["name", "description", "modifiers"]
  }
};

export const REGISTRY_IDS = Object.keys(REGISTRY_KINDS);

export function registryKind(kindId) {
  return REGISTRY_KINDS[kindId] || null;
}

/** The registry a repository path belongs to, or null. */
export function kindForPath(path) {
  return REGISTRY_IDS.find((id) => REGISTRY_KINDS[id].path === path) || null;
}

/* ---------------------------------------------------------------
 * DETERMINISTIC SERIALIZATION
 *
 * Two authored states that mean the same thing must produce the same bytes.
 * Everything here exists to make that true: fixed key order, fixed entity
 * order, no transient fields, and a trailing newline so diffs stay clean.
 * -------------------------------------------------------------*/

function orderKeys(value, fieldOrder) {
  if (Array.isArray(value)) return value.map((entry) => orderKeys(entry, []));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const key of fieldOrder) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = orderKeys(value[key], []);
  }
  // Nested objects keep their own authored key order rather than being sorted:
  // a stat block reads better as maxHp, attack, defense than alphabetically,
  // and the authored order is already stable.
  for (const key of Object.keys(value)) {
    if (fieldOrder.includes(key)) continue;
    out[key] = orderKeys(value[key], []);
  }
  return out;
}

/** One entity, with its keys in canonical order. */
export function canonicalEntity(kindId, entity) {
  const kind = registryKind(kindId);
  const source = entity && typeof entity === "object" ? entity : {};
  // `id` is the key in the file, never a field inside the entity — carrying it
  // in both places is how the two drift apart.
  const withoutId = { ...source };
  delete withoutId.id;
  return orderKeys(withoutId, (kind && kind.fieldOrder) || []);
}

/**
 * A whole registry file.
 *
 * Entities are written in id order. Authored order in the original App.jsx
 * literal was incidental — nothing reads it — and sorting makes a diff of two
 * exports show only what actually changed.
 */
export function serializeRegistryFile(kindId, entries) {
  const kind = registryKind(kindId);
  const body = {};
  for (const id of Object.keys(entries || {}).sort()) {
    body[id] = canonicalEntity(kindId, entries[id]);
  }
  return (
    JSON.stringify(
      {
        format: GAMEPLAY_FORMAT_ID,
        formatVersion: GAMEPLAY_FORMAT_VERSION,
        registry: kindId,
        description: kind ? kind.summary : "",
        entries: body
      },
      null,
      2
    ) + "\n"
  );
}

/** Reads a registry file back. Tolerates a bare `{ id: entity }` map too. */
export function parseRegistryFile(text) {
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  if (!parsed || typeof parsed !== "object") return { registry: null, entries: {} };
  if (parsed.entries && typeof parsed.entries === "object") {
    return { registry: parsed.registry || null, entries: parsed.entries };
  }
  return { registry: null, entries: parsed };
}

/**
 * Semantic equality between two entities.
 *
 * Compares canonical forms, so re-serializing something never marks it dirty
 * and a key typed in a different order is not a change.
 */
export function entitiesEqual(kindId, a, b) {
  if (!a || !b) return a === b;
  return JSON.stringify(canonicalEntity(kindId, a)) === JSON.stringify(canonicalEntity(kindId, b));
}
