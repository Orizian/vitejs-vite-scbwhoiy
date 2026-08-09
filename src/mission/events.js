/* =========================================================================
 * MISSION EVENT STREAM
 *
 * The simulation already emits typed, serializable events through its
 * resolution queue (EVENT_HANDLERS in App.jsx). This module turns that stream
 * into the vocabulary mission scripts speak, so the scripting layer never has
 * to rescan the battle log.
 *
 * Two rules:
 *
 *   1. A mission event is plain serializable data. No callbacks, no live
 *      references into battle state. That is what lets a save/reload resume
 *      mid-sequence and what lets deterministic replay reproduce a scripted
 *      battle exactly.
 *
 *   2. Derivation is pure. `deriveMissionEvents` reads a simulation event plus
 *      a small read-only view of the battle and returns events. It never
 *      mutates anything.
 *
 * Adding a new event type is a data edit here plus, usually, nothing else —
 * the trigger registry matches on `type` and field equality generically.
 * =======================================================================*/

/**
 * The catalog. `fields` are the properties a trigger may match on, and the
 * editor builds its trigger forms from exactly this list, so an author can
 * never reference a field that does not exist.
 *
 * `derived: true` marks events this module synthesises rather than ones the
 * simulation emits directly.
 */
export const MISSION_EVENT_TYPES = [
  { id: "battleStarted", name: "Battle started", fields: [] },
  { id: "activationStarted", name: "Activation started", fields: ["unitRef", "teamId", "activationIndex"] },
  { id: "activationEnded", name: "Activation ended", fields: ["unitRef", "teamId"] },
  { id: "unitMoved", name: "Unit moved", fields: ["unitRef", "teamId"] },
  { id: "unitEnteredRegion", name: "Unit entered region", fields: ["unitRef", "teamId", "regionRef"], derived: true },
  { id: "unitLeftRegion", name: "Unit left region", fields: ["unitRef", "teamId", "regionRef"], derived: true },
  { id: "attackDeclared", name: "Attack declared", fields: ["unitRef", "teamId", "abilityId"] },
  { id: "attackResolved", name: "Attack resolved", fields: ["unitRef", "teamId", "abilityId"], derived: true },
  { id: "unitDamaged", name: "Unit damaged", fields: ["unitRef", "teamId", "sourceRef"] },
  { id: "unitHpBelowThreshold", name: "Unit HP below threshold", fields: ["unitRef", "teamId", "percent"], derived: true },
  { id: "unitDisabled", name: "Unit disabled", fields: ["unitRef", "teamId"] },
  { id: "unitDestroyed", name: "Unit destroyed", fields: ["unitRef", "teamId"] },
  { id: "wreckCreated", name: "Wreck created", fields: ["unitRef", "teamId"], derived: true },
  { id: "repairCompleted", name: "Repair completed", fields: ["unitRef", "teamId", "sourceRef"] },
  { id: "resourceChanged", name: "Resource changed", fields: ["unitRef", "resourceId"] },
  { id: "objectiveProgressed", name: "Objective progressed", fields: ["objectiveRef"] },
  { id: "objectiveCompleted", name: "Objective completed", fields: ["objectiveRef"] },
  { id: "objectiveFailed", name: "Objective failed", fields: ["objectiveRef"] },
  { id: "groupAlerted", name: "Group alerted", fields: ["groupRef"] },
  { id: "groupSpawned", name: "Group spawned", fields: ["groupRef"] },
  { id: "eliteSpotted", name: "Elite spotted", fields: ["unitRef", "teamId"], derived: true },
  { id: "factionChanged", name: "Faction relationship changed", fields: ["teamId", "otherTeamId", "relationship"] },
  {
    id: "knowledgeChanged",
    name: "Faction knowledge changed",
    // `from`/`to` are knowledge states, `reason` is why it moved: observed,
    // contactLost, decayed, recon or a scripted source. This is the trigger an
    // author reaches for to write "the moment they spot you".
    fields: ["factionId", "unitRef", "teamId", "from", "to", "reason"]
  },
  { id: "terrainDestroyed", name: "Terrain changed", fields: ["terrainId", "regionRef"] },
  { id: "phaseStarted", name: "Phase started", fields: ["phaseRef"] },
  { id: "phaseCompleted", name: "Phase completed", fields: ["phaseRef"] },
  { id: "missionFactSet", name: "Mission fact set", fields: ["fact"] },
  { id: "sceneCompleted", name: "Scene completed", fields: ["sceneRef", "choiceId", "optionId"] }
];

export const MISSION_EVENT_TYPE_IDS = MISSION_EVENT_TYPES.map((entry) => entry.id);

export function missionEventTypeById(id) {
  return MISSION_EVENT_TYPES.find((entry) => entry.id === id) || null;
}

/* ---------------------------------------------------------------
 * DERIVATION
 * -------------------------------------------------------------*/

/**
 * @param simEvent  one event from the engine's resolution queue
 * @param view      {
 *                    unitRefById(id) -> authored ref or runtime id,
 *                    unitTeam(id),
 *                    unitTags(id),
 *                    hpPercent(id),
 *                    regionsContaining(x, y) -> [regionId],
 *                    thresholds: [numbers]   // HP percents worth announcing
 *                  }
 * @returns array of mission events (may be empty)
 */
export function deriveMissionEvents(simEvent, view) {
  const out = [];
  const ref = (id) => (id == null ? null : view.unitRefById(id));
  const team = (id) => (id == null ? null : view.unitTeam(id));

  switch (simEvent.type) {
    case "unitActivated":
      out.push({
        type: "activationStarted",
        unitRef: ref(simEvent.unitId),
        teamId: team(simEvent.unitId),
        activationIndex: simEvent.activationIndex == null ? null : simEvent.activationIndex
      });
      break;

    case "turnEnded":
      out.push({ type: "activationEnded", unitRef: ref(simEvent.unitId), teamId: team(simEvent.unitId) });
      break;

    case "unitMoved": {
      const unitRef = ref(simEvent.unitId);
      const teamId = team(simEvent.unitId);
      out.push({ type: "unitMoved", unitRef, teamId, from: simEvent.from, to: simEvent.to });

      // Region transitions come from the path rather than from polling, so a
      // unit that crosses a region and leaves it in one move still fires both.
      const path = simEvent.path || [simEvent.from, simEvent.to];
      const seen = new Set();
      const startRegions = new Set(view.regionsContaining(path[0].x, path[0].y));
      const endRegions = new Set(view.regionsContaining(path[path.length - 1].x, path[path.length - 1].y));

      for (const tile of path) {
        for (const regionRef of view.regionsContaining(tile.x, tile.y)) {
          if (startRegions.has(regionRef) || seen.has(regionRef)) continue;
          seen.add(regionRef);
          out.push({ type: "unitEnteredRegion", unitRef, teamId, regionRef });
        }
      }
      for (const regionRef of startRegions) {
        if (endRegions.has(regionRef)) continue;
        out.push({ type: "unitLeftRegion", unitRef, teamId, regionRef });
      }
      break;
    }

    case "abilityUsed":
      out.push({
        type: "attackDeclared",
        unitRef: ref(simEvent.sourceUnitId),
        teamId: team(simEvent.sourceUnitId),
        abilityId: simEvent.abilityId,
        targetRefs: (simEvent.targetUnitIds || []).map(ref)
      });
      out.push({
        type: "attackResolved",
        unitRef: ref(simEvent.sourceUnitId),
        teamId: team(simEvent.sourceUnitId),
        abilityId: simEvent.abilityId,
        targetRefs: (simEvent.targetUnitIds || []).map(ref)
      });
      break;

    case "damageResolved": {
      // Damage and heal events name their subject `targetUnitId`, not `unitId`.
      const subjectId = simEvent.targetUnitId;
      const unitRef = ref(subjectId);
      const teamId = team(subjectId);
      out.push({
        type: "unitDamaged",
        unitRef,
        teamId,
        sourceRef: ref(simEvent.sourceUnitId),
        amount: simEvent.appliedAmount == null ? simEvent.amount || 0 : simEvent.appliedAmount
      });
      // One event per threshold crossed, so a script can watch "below 50%"
      // without polling every activation.
      const percent = view.hpPercent(subjectId);
      for (const threshold of view.thresholds) {
        if (percent <= threshold) {
          out.push({ type: "unitHpBelowThreshold", unitRef, teamId, percent: threshold });
        }
      }
      break;
    }

    case "knowledgeChanged":
      out.push({
        type: "knowledgeChanged",
        factionId: simEvent.factionId,
        unitRef: ref(simEvent.unitId),
        teamId: team(simEvent.unitId),
        from: simEvent.from,
        to: simEvent.to,
        reason: simEvent.reason || "observed"
      });
      break;

    case "healResolved":
      out.push({
        type: "repairCompleted",
        unitRef: ref(simEvent.targetUnitId),
        teamId: team(simEvent.targetUnitId),
        sourceRef: ref(simEvent.sourceUnitId),
        amount: simEvent.amount == null ? 0 : simEvent.amount
      });
      break;

    case "unitDefeated": {
      const unitRef = ref(simEvent.unitId);
      const teamId = team(simEvent.unitId);
      // Destroyed and disabled are the same engine event today; CAP-01 will
      // split them, and scripts written against either keep working.
      out.push({ type: "unitDestroyed", unitRef, teamId });
      out.push({ type: "unitDisabled", unitRef, teamId });
      out.push({ type: "wreckCreated", unitRef, teamId, x: simEvent.x, y: simEvent.y });
      break;
    }

    case "resourceSpent":
    case "resourceRestored":
      out.push({
        type: "resourceChanged",
        unitRef: ref(simEvent.targetUnitId || simEvent.sourceUnitId),
        teamId: team(simEvent.targetUnitId || simEvent.sourceUnitId),
        resourceId: simEvent.resourceId,
        direction: simEvent.type === "resourceSpent" ? "spent" : "restored",
        amount: simEvent.amount == null ? 0 : simEvent.amount
      });
      break;

    case "unitSpawned":
    case "unitDeployed":
      out.push({
        type: "activationStarted",
        unitRef: ref(simEvent.unitId),
        teamId: team(simEvent.unitId),
        spawned: true,
        activationIndex: null
      });
      break;

    case "terrainCreated":
    case "terrainRemoved":
      out.push({
        type: "terrainDestroyed",
        terrainId: simEvent.terrainId || null,
        x: simEvent.x,
        y: simEvent.y,
        regionRef: (view.regionsContaining(simEvent.x, simEvent.y) || [])[0] || null
      });
      break;

    default:
      break;
  }

  // Elites are worth a dedicated event because "an ace is on the field" is a
  // recurring authored beat and tag lookup is engine-side.
  const spotlightId = simEvent.unitId || simEvent.sourceUnitId;
  if (
    spotlightId &&
    (simEvent.type === "unitActivated" ||
      simEvent.type === "unitSpawned" ||
      simEvent.type === "unitDeployed")
  ) {
    if ((view.unitTags(spotlightId) || []).includes("elite")) {
      out.push({ type: "eliteSpotted", unitRef: ref(spotlightId), teamId: team(spotlightId) });
    }
  }

  return out;
}

/** HP thresholds worth emitting an event for. Kept small on purpose — one
 *  event per damage instance per threshold, not a continuous stream. */
export const DEFAULT_HP_THRESHOLDS = [75, 50, 25, 10];
