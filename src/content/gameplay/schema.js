import {
  STATUS_TRIGGER_EVENT_IDS,
  STATUS_TRIGGER_TARGETS,
  EFFECT_CONDITION_IDS,
  EFFECT_SCALING_SOURCE_IDS,
  EFFECT_SCALING_MODES
} from "../../combat/authoring.js";

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
import { SELECTION_POLICY_IDS } from "../../combat/propagation.js";
import { FIXTURE_STATES, FIXTURE_VISIBILITY } from "../../combat/fixtures.js";
import { HOSTILE_BARRIER_MODES, WINDOW_RELATIONSHIPS } from "../../combat/sequencing.js";

/** The chain's selection policies, offered to the author as a closed list. */
const SELECTION_POLICY_OPTIONS = SELECTION_POLICY_IDS;

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
  { key: "maxDrop", label: "Max drop" },
  {
    key: "displacementResistance",
    label: "Displacement resistance",
    help: "Tiles subtracted from any forced move. A bolted-down emplacement shrugs off a shove."
  },
  {
    key: "propagationRadiusBonus",
    label: "Propagation radius bonus",
    help: "Extra tiles a chain may cross when arcing to or from this frame. A status can move it."
  }
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
            behaviour: true,
            help:
              "A damage effect may carry `scaling`: one block or a list of them, each " +
              "{ from, perUnit } with an optional mode (" + EFFECT_SCALING_MODES.join(", ") +
              "), min and max. Sources: " + EFFECT_SCALING_SOURCE_IDS.join(", ") +
              '. `targetStatus` names a statusId or a statusTag and counts what the ' +
              "target is already carrying, which is how a mark becomes a number."
          }
        ]
      },
      {
        id: "trajectory",
        label: "Trajectory",
        note:
          "Present only on route actions. Leave it empty and the ability is an " +
          "ordinary targeted one. `contactEffects` resolve where the route touches " +
          "something and the route continues afterwards unless told not to.",
        fields: [
          {
            key: "trajectory.maxSegments",
            label: "Maximum segments",
            kind: "number",
            help: "A segment travels in one heading. Two segments means one turn."
          },
          {
            key: "trajectory.maxDistance",
            label: "Maximum distance",
            kind: "number",
            help: "Empty means the mover's own movement stat."
          },
          {
            key: "trajectory.allowedRedirects",
            label: "Permitted turns",
            kind: "tags",
            behaviour: true,
            help: "straight · slight · quarter · sharp · reverse. Anything absent is refused before execution."
          },
          {
            key: "trajectory.resourceId",
            label: "Turns are paid from",
            kind: "ref",
            registry: "resources"
          },
          {
            key: "trajectory.redirectCosts",
            label: "Cost per turn category",
            kind: "numberMap",
            help: "Keys are turn categories; values are amounts of the resource above."
          },
          {
            key: "trajectory.continueAfterContact",
            label: "Route continues after contact",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "trajectory.contactEffects",
            label: "On contact",
            kind: "objectList",
            typeKey: "type",
            behaviour: true,
            help: "A `displace` effect's distance is the maximum; the player chooses the actual distance."
          }
        ]
      },
      {
        id: "activationWindow",
        label: "Command window",
        note:
          "Present only on actions that set the order of activations already coming. " +
          "Nobody gains a turn and nobody loses one — the same units act the same " +
          "number of times, in an order the commander chose. An ability with this " +
          "block is issued as a command rather than as an ordinary action, so its " +
          "effect list is never run.",
        fields: [
          {
            key: "activationWindow.relationship",
            label: "May sequence",
            kind: "enum",
            options: WINDOW_RELATIONSHIPS,
            behaviour: true,
            help: '"allied" is a commander rearranging her own squad. "any" would let her reorder the enemy too.'
          },
          {
            key: "activationWindow.lookahead",
            label: "Reach ahead (time)",
            kind: "number",
            help: "How far past the present an activation may be and still be commandable."
          },
          {
            key: "activationWindow.maxUnits",
            label: "Most units sequenced",
            kind: "number",
            help: "Fewer than two leaves no order to change."
          },
          {
            key: "activationWindow.hostileBarrier",
            label: "Enemy activations",
            kind: "enum",
            options: HOSTILE_BARRIER_MODES,
            behaviour: true,
            help:
              '"stop" makes an enemy turn a wall the command cannot reach past, which is ' +
              "what keeps initiative a real system. \"ignore\" lets allies be moved across it."
          },
          {
            key: "activationWindow.includeActive",
            label: "Can sequence the unit acting now",
            kind: "boolean",
            behaviour: true,
            help: "Normally false: the commander is standing in the present, not waiting in the queue."
          }
        ]
      },
      {
        id: "fixtureTargeting",
        label: "Fixture targeting",
        note:
          "Present only on actions that command a device already on the map — a " +
          "remote charge, a beacon, a deployable. Selection is by tag, never by " +
          "fixture id, so a new device of the same kind needs no code and no new " +
          "ability.",
        fields: [
          {
            key: "fixtureTargeting.tag",
            label: "Commands fixtures tagged",
            kind: "line",
            help: "Any fixture carrying this tag is eligible. Empty means any fixture."
          },
          {
            key: "fixtureTargeting.ownership",
            label: "Whose devices",
            kind: "enum",
            options: ["own", "team", "any"],
            behaviour: true
          },
          {
            key: "fixtureTargeting.states",
            label: "In state",
            kind: "tags",
            behaviour: true,
            help: FIXTURE_STATES.join(" · ")
          },
          { key: "fixtureTargeting.rangeMax", label: "Maximum range", kind: "number" },
          {
            key: "fixtureTargeting.requiresLineOfSight",
            label: "Requires line of sight",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "fixtureAction",
            label: "What it does to the device",
            kind: "enum",
            options: ["", "disarm", "arm", "remove"],
            behaviour: true,
            help: "Empty activates it. Anything else changes its state instead."
          }
        ]
      },
      {
        id: "propagation",
        label: "Propagation",
        note:
          "Present only on chaining actions. The player picks the first target; " +
          "every later one is chosen from live positions relative to the target " +
          "before it. `maxHops` counts arcs, so 3 reaches four units in total. " +
          "The effects that run on each node are the ordinary `propagate` effect's " +
          "own list, which is why a chain of statuses or heals needs nothing new.",
        fields: [
          {
            key: "propagation.maxHops",
            label: "Maximum arcs",
            kind: "number",
            help: "Arcs after the initial target. Hard-capped by the engine however high this goes."
          },
          {
            key: "propagation.hopRadius",
            label: "Arc range",
            kind: "number",
            help: "Tiles the chain may cross between one target and the next, before any conductivity bonus."
          },
          {
            key: "propagation.relationship",
            label: "Arcs to",
            kind: "enum",
            options: ["enemy", "ally", "any", "self"],
            behaviour: true
          },
          {
            key: "propagation.selection",
            label: "Chooses",
            kind: "enum",
            options: SELECTION_POLICY_OPTIONS,
            behaviour: true,
            help: "How the next node is picked. Every policy is fully ordered, so a replay chains identically."
          },
          {
            key: "propagation.requiresLineOfSight",
            label: "Needs sight between nodes",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "propagation.allowRepeat",
            label: "May strike the same target twice",
            kind: "boolean",
            behaviour: true,
            help: "Off by default. On, the arc count is the only thing bounding the chain."
          },
          {
            key: "propagation.includeSource",
            label: "May arc through the caster",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "propagation.allowsDefeated",
            label: "May arc to destroyed units",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "propagation.filters",
            label: "Node filters",
            kind: "objectList",
            typeKey: "type",
            behaviour: true,
            help: "Applied to every candidate, in addition to the relationship above."
          }
        ]
      },
      {
        id: "conditions",
        label: "Conditions",
        fields: [
          {
            key: "conditions",
            label: "Use conditions",
            kind: "objectList",
            typeKey: "type",
            behaviour: true,
            vocabulary: EFFECT_CONDITION_IDS,
            help:
              'A resource question is { type: "resourceBalance", resourceId, of: "source" | ' +
              '"target", compare, value } and may add percentOfMax. Which pool it reads ' +
              "comes from the resource's own scope, so a squad budget and a personal " +
              "rack are asked about identically."
          },
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
          {
            key: "removesAbilities",
            label: "Takes these offline",
            kind: "refList",
            registry: "abilities",
            behaviour: true,
            help:
              "Abilities this condition removes while it lasts. How a damaged system " +
              "stops being usable rather than merely being worse at its job."
          },
          {
            key: "blocksAbilityTags",
            label: "Takes tagged actions offline",
            kind: "tags",
            behaviour: true,
            help:
              "Any ability carrying one of these tags is unavailable while this holds. " +
              "Prefer it to a list of ids when the impairment is about a kind of " +
              "capability rather than one particular action."
          },
          {
            key: "triggers",
            label: "Triggers",
            kind: "objectList",
            typeKey: "event",
            behaviour: true,
            vocabulary: STATUS_TRIGGER_EVENT_IDS,
            help:
              'Each entry is { event, effects } and may add target: "' +
              STATUS_TRIGGER_TARGETS.join('" | "') +
              '". A counterpart is the other party in the moment — whoever dealt ' +
              "the damage, or the unit that was destroyed — and only the moments " +
              "that have one accept it."
          }
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
    idLabel: "Operator id",
    nameKey: "name",
    categorize: (entry) => (entry.recruit ? "Recruitable" : "Starting lance"),
    sections: [
      {
        id: "identity",
        label: "Identity",
        note:
          "The entry id is this pilot's one canonical name in data. Campaign roster, " +
          "deployment, mission units, links and reactions all address them by it, and " +
          "renaming the display name never touches it.",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
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
          "beside it are authored. Three of them — cancel, redirect and intercept — change " +
          "the action that triggered the reaction rather than responding to it, and only " +
          'work on the "actionDeclared" trigger, because an action can only be changed ' +
          "before it resolves.",
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
          "Canonical operator ids. A link is active only while every participant is " +
          "deployed, able to act and allied.",
        fields: [
          { key: "participants", label: "Operators", kind: "refList", registry: "operators" },
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
  },

  fixtures: {
    idLabel: "Fixture ref",
    nameKey: "name",
    categorize: (entry) => {
      const tags = entry.tags || [];
      if (tags.includes("trap")) return "Traps";
      if (tags.includes("commandable")) return "Commanded devices";
      return "Other fixtures";
    },
    sections: [
      {
        id: "identity",
        label: "Identity",
        fields: [
          { key: "name", label: "Display name", kind: "line", required: true },
          { key: "glyph", label: "Glyph", kind: "line" },
          { key: "description", label: "Description", kind: "text", rows: 3 },
          {
            key: "tags",
            label: "Tags",
            kind: "tags",
            help: "How commanding abilities select this. A detonator targets a tag, never an id."
          }
        ]
      },
      {
        id: "presence",
        label: "On the map",
        note:
          "A fixture sits on a tile without being a unit: it takes no turn, has " +
          "no health, and normally does not block the tile it is on.",
        fields: [
          {
            key: "visibility",
            label: "Who can see it",
            kind: "enum",
            options: FIXTURE_VISIBILITY,
            behaviour: true,
            help: "Its owner always can. Once something is revealed it stays revealed."
          },
          {
            key: "blocksMovement",
            label: "Blocks its tile",
            kind: "boolean",
            behaviour: true,
            help: "Off for a trap — a mine nobody can walk onto is not a mine."
          },
          {
            key: "stacks",
            label: "May share a tile with its own kind",
            kind: "boolean",
            behaviour: true
          },
          {
            key: "triggerTiles",
            label: "Extra trigger tiles",
            kind: "objectList",
            help: "Tiles beyond the anchor that also set it off. Empty means the anchor alone."
          }
        ]
      },
      {
        id: "lifecycle",
        label: "State",
        fields: [
          {
            key: "initialState",
            label: "Starts",
            kind: "enum",
            options: FIXTURE_STATES.filter((entry) => entry !== "removed" && entry !== "triggered"),
            behaviour: true
          },
          {
            key: "charges",
            label: "Activations",
            kind: "number",
            help: "How many times it can go off. Empty means unlimited."
          },
          {
            key: "consumedOnTrigger",
            label: "Removed when spent",
            kind: "boolean",
            behaviour: true,
            help: "Off leaves an inert device on the map instead of clearing it."
          }
        ]
      },
      {
        id: "trigger",
        label: "What sets it off",
        fields: [
          {
            key: "trigger.type",
            label: "Trigger",
            kind: "enum",
            options: ["unitEnters", "command"],
            behaviour: true
          },
          {
            key: "trigger.triggeredBy",
            label: "Triggered by",
            kind: "enum",
            options: ["enemy", "ally", "any"],
            behaviour: true
          },
          {
            key: "trigger.includesOwner",
            label: "Its own owner sets it off",
            kind: "boolean",
            behaviour: true
          }
        ]
      },
      {
        id: "activation",
        label: "What it does",
        note:
          "An ordinary effect list against ordinary area targeting. There is no " +
          "blast system: a charge that damages and shoves is the same machinery " +
          "as an ability that damages and shoves.",
        fields: [
          {
            key: "area.shape",
            label: "Area shape",
            kind: "enum",
            options: ["single", "adjacent", "diamond", "square", "line", "cone"],
            behaviour: true
          },
          { key: "area.radius", label: "Area radius", kind: "number" },
          {
            key: "affects",
            label: "Affects",
            kind: "enum",
            options: ["enemy", "ally", "any"],
            behaviour: true
          },
          {
            key: "effects",
            label: "Effects",
            kind: "objectList",
            typeKey: "type",
            behaviour: true,
            help:
              "A damage effect may carry `scaling`: one block or a list of them, each " +
              "{ from, perUnit } with an optional mode (" + EFFECT_SCALING_MODES.join(", ") +
              "), min and max. Sources: " + EFFECT_SCALING_SOURCE_IDS.join(", ") +
              '. `targetStatus` names a statusId or a statusTag and counts what the ' +
              "target is already carrying, which is how a mark becomes a number."
          }
        ]
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
    fixtures: {
      name: "New Fixture",
      glyph: "◈",
      description: "",
      tags: [],
      visibility: "ownerTeam",
      initialState: "armed",
      trigger: { type: "unitEnters", triggeredBy: "enemy" },
      area: { shape: "single" },
      affects: "enemy",
      effects: [],
      charges: 1,
      consumedOnTrigger: true,
      blocksMovement: false,
      stacks: false,
      triggerTiles: []
    },
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
