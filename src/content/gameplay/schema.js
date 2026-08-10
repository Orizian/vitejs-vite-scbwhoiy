/* =========================================================================
 * GAMEPLAY EDITOR SCHEMA
 *
 * What the Studio may edit, and with what control. One declaration per
 * registry, so the inspector never contains `if (unit.id === "nyx")`.
 *
 * Two distinctions this file is careful about:
 *
 *   DATA PARAMETER   a number or reference the engine reads. Editable.
 *   ENGINE BEHAVIOUR a flag that *selects* engine code. Editable as a
 *                    selector, but the behaviour behind it is not authored —
 *                    fields carry `behaviour: true` and the Studio says so.
 *
 * There is deliberately no free-text formula field and no code field anywhere
 * in here. The Studio authors content parameters; it does not rewrite the
 * simulation.
 *
 * Field kinds the inspector understands:
 *   line · text · number · boolean · enum · tags
 *   ref  · refList        a stable id in another registry
 *   statBlock             a fixed set of named numbers
 *   objectList            authored sub-objects (modifiers, effects)
 *   readonly              derived or engine-owned; shown, never edited
 * =======================================================================*/

import { REGISTRY_KINDS } from "./format.js";

/** Stats every unit carries. Mirrors DEFAULT_BASE_STATS in the engine. */
export const BASE_STAT_FIELDS = [
  { key: "maxHp", label: "Max HP" },
  { key: "attack", label: "Attack" },
  { key: "magic", label: "Magic" },
  { key: "defense", label: "Defense" },
  { key: "resistance", label: "Resistance" },
  { key: "speed", label: "Speed" },
  { key: "accuracy", label: "Accuracy" },
  { key: "evasion", label: "Evasion" },
  { key: "movement", label: "Movement" },
  { key: "maxClimb", label: "Max climb" },
  { key: "maxDrop", label: "Max drop" }
];

export const OBSERVATION_CHANNEL_FIELDS = ["optical", "thermal", "signal", "acoustic", "intel"];

const perceptionSection = {
  id: "perception",
  label: "Sensors and emissions",
  note:
    "What this can detect, and what it gives off. Ranges compose by maximum; " +
    "emissions compose by product, so a suppressor cannot be out-stacked.",
  fields: [
    {
      key: "perception.sensors",
      label: "Sensor ranges",
      kind: "channelMap",
      unit: "tiles",
      help: "Zero means no sensor on that channel."
    },
    {
      key: "perception.emissions",
      label: "Emission factors",
      kind: "channelMap",
      factor: true,
      help: "1 is an ordinary body. 0 is silent on that channel."
    }
  ]
};

export const REGISTRY_SCHEMAS = {
  units: {
    idLabel: "Unit ref",
    nameKey: "name",
    /** How the library groups and labels entries, from authored data only. */
    categorize: (entry) => {
      const tags = entry.tags || [];
      if (tags.includes("structure")) return "Structures";
      if (tags.includes("civilian")) return "Civilians";
      if (tags.includes("government")) return "Government forces";
      if (tags.includes("deployable")) return "Player chassis";
      return "Other units";
    },
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "classId", label: "Class", kind: "line", help: "Drives equipment compatibility." },
          { key: "role", label: "Role", kind: "line" },
          { key: "glyph", label: "Glyph", kind: "line" },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          { key: "tags", label: "Tags", kind: "tags" }
        ]
      },
      {
        id: "stats",
        label: "Base stats",
        note: "The frame's own numbers, before a pilot, equipment or perks.",
        fields: [
          { key: "baseStats", label: "Base stats", kind: "statBlock", stats: BASE_STAT_FIELDS },
          {
            key: "resources",
            label: "Resource pools",
            kind: "resourceMap",
            help:
              "Named pools abilities can spend, beyond the universal move/act budget. " +
              "A pool starts at `startsAt`, or full when that is unset."
          }
        ]
      },
      {
        id: "abilities",
        label: "Abilities",
        fields: [
          { key: "abilities", label: "Abilities", kind: "refList", registry: "abilities" },
          { key: "defaultAbilityId", label: "Default ability", kind: "ref", registry: "abilities" }
        ]
      },
      {
        id: "behaviour",
        label: "Behaviour",
        fields: [
          {
            key: "aiProfile",
            label: "AI profile",
            kind: "ref",
            registry: "aiProfiles",
            behaviour: true,
            help: "Selects a weight vector. The AI's behaviour is engine code."
          }
        ]
      },
      perceptionSection,
      {
        id: "loadout",
        label: "Default equipment",
        fields: [
          {
            key: "defaultEquipment",
            label: "Default loadout",
            kind: "slotMap",
            registry: "equipment",
            help: "What this unit fields when nothing else is specified."
          }
        ]
      },
      {
        id: "assets",
        label: "Art",
        // Derived, not authored. The engine assigns every unit its asset ids
        // from the unit's own id, so there is nothing here to type — and a
        // text box that the loader silently overwrites would be a lie.
        note:
          "Art is found by file path, not by an id typed here. Drop files at " +
          "public/assets/units/<unit id>/portrait.webp and .../battlefield.webp " +
          "(png, jpg and jpeg also work). Directional sprites use " +
          "battlefield-northeast, -southeast, -southwest, -northwest. Until a " +
          "file exists the unit falls back to its glyph.",
        fields: []
      }
    ]
  },

  abilities: {
    idLabel: "Ability ref",
    nameKey: "name",
    categorize: (entry) => ((entry.ui && entry.ui.category) || "action") + "s",
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          { key: "tags", label: "Tags", kind: "tags" },
          {
            key: "activation",
            label: "Activation",
            kind: "enum",
            options: ["manual", "passive", "reaction"],
            behaviour: true
          }
        ]
      },
      {
        id: "targeting",
        label: "Targeting",
        fields: [
          {
            key: "targeting.type",
            label: "Target type",
            kind: "enum",
            options: ["enemy", "ally", "self", "any", "emptyTile"],
            behaviour: true
          },
          { key: "targeting.rangeMin", label: "Minimum range", kind: "number" },
          { key: "targeting.rangeMax", label: "Maximum range", kind: "number" },
          { key: "targeting.requiresLineOfSight", label: "Requires line of sight", kind: "boolean" },
          { key: "targeting.allowsDefeated", label: "May target defeated", kind: "boolean" },
          {
            key: "targeting.area.shape",
            label: "Area shape",
            kind: "enum",
            options: ["single", "adjacent", "diamond", "square", "line", "cone"],
            behaviour: true
          },
          { key: "targeting.area.radius", label: "Area radius", kind: "number" }
        ]
      },
      {
        id: "timing",
        label: "Timing and cost",
        fields: [
          { key: "timing.recovery", label: "Recovery", kind: "number" },
          { key: "timing.cooldown", label: "Cooldown", kind: "number" },
          { key: "costs", label: "Resource costs", kind: "numberMap" }
        ]
      },
      {
        id: "effects",
        label: "Effects",
        note:
          "Resolved in order by the engine's effect registry. `type` selects " +
          "engine behaviour; the numbers beside it are authored.",
        fields: [
          {
            key: "effects",
            label: "Effects",
            kind: "objectList",
            typeKey: "type",
            behaviour: true
          }
        ]
      },
      {
        id: "conditions",
        label: "Conditions",
        fields: [
          { key: "conditions", label: "Use conditions", kind: "objectList", typeKey: "type", behaviour: true },
          {
            key: "requirementText",
            label: "Why it is unavailable",
            kind: "line",
            help:
              "Shown to the player when a condition blocks the ability. Write the " +
              "requirement, not the failure — \"Requires Brace.\" rather than \"Not braced.\""
          }
        ]
      },
      {
        id: "ui",
        label: "Presentation",
        fields: [
          { key: "ui.category", label: "Menu category", kind: "line" },
          { key: "ui.order", label: "Menu order", kind: "number" },
          { key: "ui.basic", label: "Counts as a basic action", kind: "boolean" }
        ]
      }
    ]
  },

  equipment: {
    idLabel: "Equipment ref",
    nameKey: "name",
    categorize: (entry) => {
      const slot = entry.slot || "utilitySystem";
      return (
        {
          primaryWeapon: "Weapons",
          armor: "Armour",
          utilitySystem: "Utility systems",
          coreSystem: "Core systems"
        }[slot] || "Other"
      );
    },
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          {
            key: "slot",
            label: "Slot",
            kind: "enum",
            options: ["primaryWeapon", "armor", "utilitySystem", "coreSystem"],
            required: true
          },
          { key: "tags", label: "Tags", kind: "tags" }
        ]
      },
      {
        id: "compatibility",
        label: "Compatibility",
        note: "Empty means every chassis can field it. Otherwise, these classes only.",
        fields: [
          { key: "compatibleClasses", label: "Compatible classes", kind: "tags" }
        ]
      },
      {
        id: "modifiers",
        label: "Stat modifiers",
        fields: [{ key: "modifiers", label: "Modifiers", kind: "modifierList" }]
      },
      perceptionSection,
      {
        id: "abilities",
        label: "Granted abilities",
        fields: [
          { key: "grantsAbilities", label: "Grants", kind: "refList", registry: "abilities" },
          { key: "removesAbilities", label: "Removes", kind: "refList", registry: "abilities" }
        ]
      }
    ]
  },

  statuses: {
    idLabel: "Status ref",
    nameKey: "name",
    categorize: (entry) => (entry.category ? entry.category[0].toUpperCase() + entry.category.slice(1) : "Other"),
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "description", label: "Description", kind: "text", rows: 2 },
          { key: "category", label: "Category", kind: "enum", options: ["positive", "negative", "neutral"] },
          { key: "glyph", label: "Glyph", kind: "line" },
          { key: "tags", label: "Tags", kind: "tags" }
        ]
      },
      {
        id: "duration",
        label: "Duration",
        fields: [
          {
            key: "duration.type",
            label: "Counted in",
            kind: "enum",
            options: ["targetActivations", "sourceActivations", "rounds", "permanent"],
            behaviour: true
          },
          { key: "duration.amount", label: "Amount", kind: "number" }
        ]
      },
      {
        id: "modifiers",
        label: "Stat modifiers",
        fields: [{ key: "modifiers", label: "Modifiers", kind: "numberMap" }]
      },
      {
        id: "behaviour",
        label: "Engine behaviour",
        note:
          "These select simulation behaviour rather than describing it. The " +
          "engine decides what concealment or a blocked action means; this " +
          "decides whether the status opts in.",
        fields: [
          { key: "preventsAction", label: "Prevents acting", kind: "boolean", behaviour: true },
          { key: "untargetable", label: "Untargetable", kind: "boolean", behaviour: true },
          { key: "hidden", label: "Hidden from opponents", kind: "boolean", behaviour: true },
          { key: "removedOnHostileAction", label: "Drops on hostile action", kind: "boolean", behaviour: true },
          { key: "removedOnMovement", label: "Drops on movement", kind: "boolean", behaviour: true },
          { key: "triggers", label: "Triggers", kind: "objectList", typeKey: "event", behaviour: true }
        ]
      },
      perceptionSection
    ]
  },

  aiProfiles: {
    idLabel: "Profile ref",
    nameKey: null,
    categorize: () => "Profiles",
    sections: [
      {
        id: "weights",
        label: "Scoring weights",
        note:
          "The AI's priorities, not its behaviour. Higher means the scorer " +
          "cares more; the search itself is engine code.",
        fields: [{ key: "*", label: "Weights", kind: "numberMap" }]
      }
    ]
  },

  operators: {
    idLabel: "Operator key",
    nameKey: "name",
    categorize: (entry) => (entry.recruit ? "Recruitable" : "Starting lance"),
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          {
            key: "ref",
            label: "Stable content ref",
            kind: "line",
            help:
              "What links, reactions and mission scripts address this pilot by. " +
              "Renaming the display name never touches it."
          },
          { key: "glyph", label: "Glyph", kind: "line" },
          { key: "role", label: "Role", kind: "text", rows: 2 }
        ]
      },
      {
        id: "frame",
        label: "Frame",
        note: "An operator points at a chassis; it does not own the chassis's stats.",
        fields: [{ key: "chassis", label: "Chassis", kind: "ref", registry: "units", required: true }]
      },
      {
        id: "progression",
        label: "Progression",
        fields: [
          { key: "perkChoices", label: "Perk choices", kind: "refList", registry: "perks" },
          { key: "recruit", label: "Recruited later", kind: "boolean" }
        ]
      }
    ]
  },

  perks: {
    idLabel: "Perk ref",
    nameKey: "name",
    categorize: () => "Perks",
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "description", label: "Description", kind: "text", rows: 2 }
        ]
      },
      {
        id: "modifiers",
        label: "Modifiers",
        fields: [{ key: "modifiers", label: "Modifiers", kind: "numberMap" }]
      }
    ]
  },

  resources: {
    idLabel: "Resource ref",
    nameKey: "name",
    categorize: (entry) => (entry.scope === "faction" ? "Shared by a faction" : "Per unit"),
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          {
            key: "scope",
            label: "Owned by",
            kind: "enum",
            options: ["unit", "faction"],
            behaviour: true,
            help:
              "A unit resource gives every frame its own balance. A faction resource " +
              "gives one whole side a single shared balance."
          },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          { key: "tags", label: "Tags", kind: "tags" }
        ]
      },
      {
        id: "balance",
        label: "Balance",
        note:
          "Starting value defaults to the maximum. A resource that starts above its " +
          "maximum is a data error, not a bonus.",
        fields: [
          { key: "max", label: "Maximum", kind: "number" },
          { key: "startsAt", label: "Starts at", kind: "number" },
          {
            key: "everyUnit",
            label: "Every unit has it",
            kind: "boolean",
            help: "Unit scope only. Off means only a chassis that declares it carries one."
          },
          {
            key: "persist",
            label: "Survives the battle",
            kind: "boolean",
            behaviour: true,
            help: "Nothing carries a resource between missions yet."
          }
        ]
      },
      {
        id: "regen",
        label: "Regeneration",
        note: "Left empty, a resource only comes back from an effect that restores it.",
        fields: [
          {
            key: "regen.on",
            label: "Regenerates on",
            kind: "enum",
            options: ["manual", "ownerActivation", "selfActivation"],
            behaviour: true
          },
          { key: "regen.amount", label: "Amount", kind: "number" }
        ]
      },
      {
        id: "gate",
        label: "Availability",
        note:
          "A gated resource keeps its points while the link is down; it simply cannot " +
          "be spent from.",
        fields: [{ key: "linkId", label: "Requires combat link", kind: "ref", registry: "combatLinks" }]
      }
    ]
  },

  reactions: {
    idLabel: "Reaction ref",
    nameKey: "name",
    categorize: (entry) => (entry.owner ? "Owned by an operator" : "Any qualifying unit"),
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          {
            key: "owner",
            label: "Owned by",
            kind: "ref",
            registry: "operators",
            refField: "ref",
            help:
              "The operator this belongs to. Leave it empty and the reaction is offered " +
              "to any unit meeting the requirements below."
          },
          {
            key: "priority",
            label: "Priority",
            kind: "number",
            help: "Higher resolves first when several compete for the same event."
          }
        ]
      },
      {
        id: "when",
        label: "WHEN",
        note:
          "The generic event that opens the window. Broad events carrying rich context, " +
          "rather than one event per situation.",
        fields: [
          {
            key: "trigger",
            label: "Trigger event",
            kind: "enum",
            options: [],
            optionsFrom: "reactionEvents",
            behaviour: true
          }
        ]
      },
      {
        id: "requires",
        label: "Offered to",
        note:
          "A cheap pre-filter for unowned reactions, so a stance-based response does not " +
          "have to be restated once per operator.",
        fields: [
          { key: "requires.status", label: "Reactor has status", kind: "ref", registry: "statuses" },
          { key: "requires.team", label: "Reactor is on team", kind: "line" }
        ]
      },
      {
        id: "if",
        label: "IF",
        note:
          "Every condition must hold when the window opens and again immediately before " +
          "the effect runs — a chain can invalidate a reaction between the two.",
        fields: [
          { key: "conditions", label: "Conditions", kind: "objectList", typeKey: "*", behaviour: true }
        ]
      },
      {
        id: "cost",
        label: "Cost",
        note:
          "Resource amounts. A reaction blocked only by cost is still shown, greyed out, " +
          "so a shortage reads as a decision rather than a missing option.",
        fields: [{ key: "cost.resources", label: "Resource cost", kind: "objectList", typeKey: "id" }]
      },
      {
        id: "limits",
        label: "Limits",
        note:
          "One event can never fire the same reaction twice; that one is always on. The " +
          "rest bound cascades without banning them.",
        fields: [
          { key: "limits.perChain", label: "Per causal chain", kind: "number" },
          { key: "limits.perActivation", label: "Per activation", kind: "number" },
          { key: "limits.perBattle", label: "Per battle", kind: "number" },
          { key: "mandatory", label: "Mandatory", kind: "boolean", behaviour: true },
          { key: "automatic", label: "Resolves automatically", kind: "boolean", behaviour: true }
        ]
      },
      {
        id: "then",
        label: "THEN",
        note:
          "One registered effect primitive. `type` selects engine behaviour; the values " +
          "beside it are authored.",
        fields: [
          { key: "effect", label: "Effect", kind: "objectList", typeKey: "type", single: true, behaviour: true }
        ]
      }
    ]
  },

  combatLinks: {
    idLabel: "Link ref",
    nameKey: "name",
    categorize: () => "Links",
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "icon", label: "Icon", kind: "line" },
          { key: "description", label: "Description", kind: "text", rows: 3 }
        ]
      },
      {
        id: "participants",
        label: "Participants",
        note:
          "Stable operator refs. A link is active only while every participant is " +
          "deployed, able to act and allied.",
        fields: [
          { key: "participants", label: "Operators", kind: "refList", registry: "operators", refField: "ref" },
          { key: "requireAll", label: "Requires all of them", kind: "boolean" },
          { key: "requireMutuallyAllied", label: "Requires mutual alliance", kind: "boolean" }
        ]
      },
      {
        id: "gates",
        label: "Gates",
        note:
          "Unlocking is campaign progression and persists; enabling is battle-local and " +
          "is what mission scripting toggles.",
        fields: [
          { key: "unlockedByDefault", label: "Unlocked by default", kind: "boolean" },
          { key: "enabledByDefault", label: "Enabled by default", kind: "boolean" }
        ]
      },
      {
        id: "reactions",
        label: "Reactions",
        fields: [{ key: "reactions", label: "Granted reactions", kind: "refList", registry: "reactions" }]
      }
    ]
  },

  terrain: {
  idLabel: "Terrain ref",
  nameKey: "name",
  categorize: (entry) => (entry.walkable === false ? "Impassable" : "Passable"),
  sections: [
    {
      id: "identity",
      label: "Identity",
      fields: [
        { key: "name", label: "Display name", kind: "line", required: true },
        {
          key: "char",
          label: "Map character",
          kind: "line",
          help: "One character. This is what the tile looks like in an exported mission file."
        },
        {
          key: "paint",
          label: "Swatch colour",
          kind: "line",
          help: "Hex colour. Used for the editor palette and as the in-game tile until art exists."
        },
        { key: "description", label: "Description", kind: "text", rows: 2 },
        { key: "tags", label: "Tags", kind: "tags" }
      ]
    },
    {
      id: "movement",
      label: "Movement and sight",
      note:
        "Leave movement cost empty for an impassable tile — nothing can enter it, " +
        "so it costs infinity by definition.",
      fields: [
        { key: "walkable", label: "Can be entered", kind: "boolean" },
        { key: "movementCost", label: "Movement cost", kind: "number" },
        { key: "blocksLineOfSight", label: "Blocks line of sight", kind: "boolean" }
      ]
    },
    {
      id: "modifiers",
      label: "Standing here",
      note:
        "Applied while a unit occupies the tile. Keys are `<stat>Flat` or " +
        "`<stat>Multiplier`, matching the status modifier vocabulary.",
      fields: [{ key: "modifiers", label: "Modifiers", kind: "numberMap" }]
    }
  ]
  }
};

export function registrySchema(kindId) {
  return REGISTRY_SCHEMAS[kindId] || null;
}

/** Every field declaration for a registry, flattened. */
export function schemaFields(kindId) {
  const schema = registrySchema(kindId);
  if (!schema) return [];
  return schema.sections.flatMap((section) => section.fields);
}

/** A new, valid, empty entity for this registry. */
export function blankEntity(kindId) {
  const defaults = {
    units: {
      name: "New Unit",
      classId: "assault",
      glyph: "?",
      description: "",
      tags: [],
      baseStats: { maxHp: 100, attack: 40, magic: 0, defense: 20, resistance: 20, speed: 100, accuracy: 100, evasion: 100, movement: 4 },
      abilities: [],
      aiProfile: "aggressive",
      assets: {}
    },
    abilities: {
      name: "New Ability",
      description: "",
      targeting: { type: "enemy", rangeMin: 1, rangeMax: 1, requiresLineOfSight: true, area: { shape: "single" } },
      timing: { recovery: 1000, cooldown: 0 },
      effects: []
    },
    equipment: {
      name: "New Equipment",
      slot: "utilitySystem",
      description: "",
      compatibleClasses: [],
      tags: [],
      modifiers: [],
      grantsAbilities: []
    },
    statuses: {
      name: "New Status",
      category: "neutral",
      glyph: "•",
      duration: { type: "targetActivations", amount: 2 },
      modifiers: {},
      triggers: []
    },
    aiProfiles: { expectedDamage: 1, lethalBonus: 40, healing: 1, targetProximity: 2, selfDanger: -1, timelineDelay: 1 },
    operators: { name: "New Operator", glyph: "?", role: "", chassis: "assaultMech", perkChoices: [] },
    perks: { name: "New Perk", description: "", modifiers: {} },
    resources: {
      name: "New Resource",
      scope: "unit",
      description: "",
      max: 3,
      startsAt: 3,
      tags: []
    },
    reactions: {
      name: "New Reaction",
      description: "",
      requires: { team: "player" },
      trigger: "unitDestroyed",
      priority: 50,
      conditions: [],
      cost: {},
      limits: { perChain: 1 },
      effect: { type: "modifyTurnDelay", target: "self", hasten: 100 }
    },
    combatLinks: {
      name: "New Link",
      icon: "\u25c8",
      description: "",
      participants: [],
      requireAll: true,
      requireMutuallyAllied: true,
      unlockedByDefault: false,
      enabledByDefault: true,
      reactions: []
    },
    terrain: {
      name: "New Terrain",
      char: "?",
      paint: "#1e293b",
      walkable: true,
      movementCost: 1,
      blocksLineOfSight: false,
      modifiers: {}
    }
  };
  return JSON.parse(JSON.stringify(defaults[kindId] || {}));
}

export { REGISTRY_KINDS };
