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
      "emissions and native abilities. Both a player chassis and an enemy " +
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
      "dropTableId",
      "perception",
      "defaultEquipment"
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
      "requirementText",
      "trajectory",
      "propagation",
      "effects",
      "tags",
      "ui"
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
      "removesAbilities"
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
      "removedOnMovement",
      "removesAbilities",
      "blocksAbilityTags",
      "perception"
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
  },
  resources: {
    id: "resources",
    label: "Resources",
    singular: "resource",
    path: "src/content/gameplay/resources.json",
    summary:
      "Every pool of points a battle tracks. `unit` scope gives each frame its " +
      "own balance; `faction` scope gives a whole side one shared balance, which " +
      "is what Command Points are. Availability is separate from balance, so a " +
      "link-gated pool keeps its points while the link is down.",
    fieldOrder: [
      "name",
      "scope",
      "description",
      "tags",
      "max",
      "startsAt",
      "everyUnit",
      "persist",
      "linkId",
      "regen"
    ]
  },
  reactions: {
    id: "reactions",
    label: "Reactions",
    singular: "reaction",
    path: "src/content/gameplay/reactions.json",
    summary:
      "Out-of-turn responses, as WHEN / IF / THEN. `trigger` is a generic event, " +
      "`conditions` a declarative vocabulary, `effect` a registered primitive. " +
      "No reaction names an engine behaviour that does not already exist.",
    fieldOrder: [
      "name",
      "description",
      "owner",
      "trigger",
      "priority",
      "requires",
      "conditions",
      "cost",
      "limits",
      "mandatory",
      "automatic",
      "effect"
    ]
  },
  combatLinks: {
    id: "combatLinks",
    label: "Combat links",
    singular: "combat link",
    path: "src/content/gameplay/combat-links.json",
    summary:
      "Relationships between operators that unlock shared reactions. A link is a " +
      "narrative gate with mechanical teeth: while it is inactive its reactions do " +
      "not merely cost more, they do not exist.",
    fieldOrder: [
      "name",
      "icon",
      "description",
      "participants",
      "requireAll",
      "requireMutuallyAllied",
      "unlockedByDefault",
      "enabledByDefault",
      "reactions"
    ]
  },
  terrain: {
    id: "terrain",
    label: "Terrain",
    singular: "terrain type",
    path: "src/content/gameplay/terrain.json",
    summary:
      "The tile palette: what it costs to cross, whether it can be crossed at " +
      "all, whether it blocks sight, and what standing in it does. `char` and " +
      "`paint` are the map editor's swatch, kept here so the palette and the " +
      "rules are one entry rather than two files that can disagree.",
    fieldOrder: [
      "name",
      "char",
      "paint",
      "description",
      "tags",
      "walkable",
      "movementCost",
      "blocksLineOfSight",
      "modifiers"
    ]
  },
  fixtures: {
    id: "fixtures",
    label: "Fixtures",
    singular: "fixture",
    path: "src/content/gameplay/fixtures.json",
    summary:
      "Things that sit on a tile and are not units: mines, charges, beacons, " +
      "deployables. A fixture belongs to somebody, remembers what state it is " +
      "in, normally does not block its tile, and disappears when it is spent. " +
      "What it does when it goes off is an ordinary effect list.",
    fieldOrder: [
      "name",
      "glyph",
      "description",
      "tags",
      "visibility",
      "initialState",
      "trigger",
      "area",
      "affects",
      "effects",
      "charges",
      "consumedOnTrigger",
      "blocksMovement",
      "stacks",
      "triggerTiles"
    ]
  },

  materials: {
    id: "materials",
    label: "Materials",
    singular: "material",
    path: "src/content/gameplay/materials.json",
    summary:
      "Stackable salvage. Not equipment — a material is never fitted to a " +
      "frame, it accumulates as a quantity and waits for something to consume " +
      "it. Crafting, upgrades and trading are all future consumers; the " +
      "registry exists now so loot authored today does not have to be " +
      "rewritten when they arrive.",
    fieldOrder: ["name", "description", "glyph", "tags", "tier"]
  },

  lootTables: {
    id: "lootTables",
    label: "Loot tables",
    singular: "loot table",
    path: "src/content/gameplay/loot-tables.json",
    summary:
      "What a reward source can pay. A table is reusable and referenced by " +
      "id: a mission names one for its clear reward, a chassis names one as " +
      "its default salvage, a specific placement names one to make a named " +
      "enemy worth hunting. `guaranteed` always pays; `pools` roll.",
    fieldOrder: ["name", "description", "tags", "guaranteed", "pools"]
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

/**
 * Ordered keys, at every depth.
 *
 * Declared fields first, in the order the registry declares them; everything
 * else alphabetically. The second half is not decoration — authored key order
 * is an accident of how someone typed, and letting it through would mean two
 * people entering the same numbers produce different bytes, which quietly
 * breaks both the diff and the export.
 *
 * Nested objects get the same treatment: a stat block reads slightly better in
 * its authored order, but "slightly better" is not worth a phantom change the
 * next time a field is cleared and retyped.
 */
function orderKeys(value, fieldOrder) {
  if (Array.isArray(value)) return value.map((entry) => orderKeys(entry, []));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const key of fieldOrder) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = orderKeys(value[key], []);
  }
  for (const key of Object.keys(value).sort()) {
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
