/* =========================================================================
 * REACTION AND LINK CONTENT
 *
 * Data, not code. Nothing in `src/reactions/` or in App.jsx names anything
 * here — the runtime reads this table, indexes it by trigger, and executes
 * registered generic effects.
 *
 * Adding a new character reaction or a new relationship is an edit to this
 * file. That is the claim this phase has to make good on.
 * =======================================================================*/

/* ---------------------------------------------------------------
 * SECTION SEVEN
 *
 * The trio's identity is tempo, not statistics. Each reaction converts one
 * member's action into another member's opportunity, and all three draw on one
 * small shared pool so the player is always choosing which conversion matters.
 *
 * These are the early-game versions. Kell's firing solution, Vale's Authority
 * and Reyes's Stock are separate systems; the reactions below use plain
 * placeholder effects and will be re-pointed at those systems when they land,
 * without the framework changing.
 * -------------------------------------------------------------*/

export const REACTION_DEFINITIONS = [
  {
    id: "sectionSevenMarkShot",
    name: "Fire on the Mark",
    description:
      "Vale paints a target and Kell fires on his data, out of turn. Kell does not spend his activation.",
    owner: "kell",
    trigger: "targetMarked",
    priority: 70,
    conditions: [
      { sourceUnit: "vale" },
      { linkActive: "sectionSeven" },
      { subjectRelation: "hostile" },
      { subjectAlive: true }
    ],
    cost: { pool: { id: "sectionSevenLink", amount: 1 } },
    limits: { perActivation: 1 },
    effect: {
      type: "reactionAttack",
      targetFrom: "subject",
      // Placeholder numbers: the real version routes through the firing
      // solution system, which does not exist yet.
      power: 95,
      formula: "physical"
    }
  },

  {
    id: "sectionSevenAdvance",
    name: "Into the Opening",
    description:
      "Kell removes something and Vale moves into the ground it was holding. A real move, never a teleport.",
    owner: "vale",
    trigger: "unitDestroyed",
    priority: 60,
    conditions: [
      { sourceUnit: "kell" },
      { linkActive: "sectionSeven" }
    ],
    cost: { pool: { id: "sectionSevenLink", amount: 1 } },
    limits: { perActivation: 1 },
    effect: { type: "advanceIntoOpening", targetFrom: "subject" }
  },

  {
    id: "sectionSevenFieldTempo",
    name: "Back in the Fight",
    description:
      "Reyes finishes a repair and the repaired frame acts immediately — one basic action, out of turn.",
    owner: "reyes",
    trigger: "repairCompleted",
    priority: 65,
    conditions: [
      { sourceUnit: "reyes" },
      { linkActive: "sectionSeven" },
      { subjectUnit: ["vale", "kell"] },
      { subjectAlive: true },
      // A token repair should not buy a free action.
      { amountAtLeast: 10 }
    ],
    cost: { pool: { id: "sectionSevenLink", amount: 1 } },
    limits: { perActivation: 1 },
    effect: { type: "partialAction", recipientFrom: "subject", grants: "basicAbility" }
  }
];

export const LINK_DEFINITIONS = [
  {
    id: "sectionSeven",
    name: "Section Seven",
    icon: "◈",
    description:
      "Six years in the same evaluation section. They do not spend actions coordinating, because they do not need to.",
    participants: ["vale", "kell", "reyes"],
    requireAll: true,
    requireMutuallyAllied: true,
    // Act I has it; Acts II–III do not. Campaign state and mission scripting
    // both drive this through the generic link gate rather than a mission id.
    unlockedByDefault: true,
    enabledByDefault: true,
    sharedPool: {
      id: "sectionSevenLink",
      name: "Section Seven tempo",
      max: 2,
      startsAt: 2,
      // A continuous timeline has no rounds, so the pool refills a point each
      // time one of the three takes a turn, capped at max.
      refreshOn: "ownerActivation",
      refreshAmount: 1
    },
    reactions: [
      "sectionSevenMarkShot",
      "sectionSevenAdvance",
      "sectionSevenFieldTempo"
    ]
  }
];

/** Pools not owned by a link. None yet; the hook exists so a skill tree can
 *  add a personal reaction pool without touching the runtime. */
export const STANDALONE_POOL_DEFINITIONS = [];

export const REACTION_CONTENT = {
  reactions: REACTION_DEFINITIONS,
  links: LINK_DEFINITIONS,
  pools: STANDALONE_POOL_DEFINITIONS
};

export function reactionDefinitionById(id) {
  return REACTION_DEFINITIONS.find((entry) => entry.id === id) || null;
}

export function linkDefinitionById(id) {
  return LINK_DEFINITIONS.find((entry) => entry.id === id) || null;
}

export const LINK_IDS = LINK_DEFINITIONS.map((entry) => entry.id);
