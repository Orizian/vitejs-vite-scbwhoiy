/* =========================================================================
 * REACTION EVENTS
 *
 * Reactions consume the *authoritative* simulation queue — the same events
 * `EVENT_HANDLERS` in App.jsx applies — and nothing else. Presentation events
 * (camera, music, scene requests) never reach this layer, which is what stops
 * a reaction from firing off something the player merely saw.
 *
 * Two stages per event, because "before the attack resolves" and "after the
 * attack resolves" are genuinely different tactical moments:
 *
 *   before  the event has been dequeued but its handler has not run.
 *           Effects resolved here land first — a guard's shield is really up
 *           when the damage is applied.
 *
 *   after   the handler has run and battle state reflects it. This is where
 *           counterattacks, pursuit and "advance into the opening" live.
 *
 * Cancellation (a before-reaction that stops the triggering event outright) is
 * deliberately NOT supported yet: it needs an event-veto contract the queue
 * does not have. `STAGES` is where it would be added.
 * =======================================================================*/

export const STAGES = ["before", "after"];

/**
 * The reaction event vocabulary.
 *
 * `from` names the simulation events each is derived from, so the derivation
 * table and the catalog can never drift apart. `fields` are what a reaction
 * may match on — the editor and validator read exactly this.
 *
 * Only events this phase actually needs are here. Adding one is a data edit
 * plus a case in `deriveReactionEvents`; matching is generic.
 */
export const REACTION_EVENT_TYPES = [
  {
    id: "activationStarted",
    name: "Activation started",
    from: ["unitActivated"],
    fields: ["unitRef", "teamId"],
    stages: ["after"]
  },
  {
    id: "activationEnded",
    name: "Activation ended",
    from: ["turnEnded"],
    fields: ["unitRef", "teamId"],
    stages: ["after"]
  },
  {
    id: "attackDeclared",
    name: "Attack declared",
    from: ["abilityUsed"],
    fields: ["unitRef", "teamId", "abilityId", "targetRefs"],
    // Declared fires *before* the ability's effects resolve, which is what
    // makes intercepts and defensive guards possible.
    stages: ["before"]
  },
  {
    id: "attackResolved",
    name: "Attack resolved",
    from: ["abilityUsed"],
    fields: ["unitRef", "teamId", "abilityId", "targetRefs"],
    stages: ["after"]
  },
  {
    id: "unitDamaged",
    name: "Unit damaged",
    from: ["damageResolved"],
    fields: ["unitRef", "teamId", "sourceRef", "amount"],
    // Both stages exist, but note what each is good for: a damage event
    // carries an already-computed amount, so a `before` reaction here can add
    // a shield (consumed inside the handler) yet cannot change defence maths.
    // Mitigation that depends on stats belongs on `attackDeclared`.
    stages: ["before", "after"]
  },
  {
    id: "unitHpBelowThreshold",
    name: "Unit HP below threshold",
    from: ["damageResolved"],
    fields: ["unitRef", "teamId", "percent"],
    stages: ["after"]
  },
  {
    id: "unitMoved",
    name: "Unit moved",
    from: ["unitMoved", "unitForcedMove"],
    fields: ["unitRef", "teamId", "sourceRef", "from", "to", "tiles", "forced"],
    // Deliberately one event for both walking and being shoved. A prepared
    // shooter does not care which; it cares that something crossed its lane.
    // `forced` is in the payload for the reactions that genuinely differ.
    stages: ["after"]
  },
  {
    id: "attackEvaded",
    name: "Attack evaded",
    from: ["attackMissed"],
    fields: ["unitRef", "teamId", "sourceRef", "abilityId"],
    stages: ["after"]
  },
  {
    id: "unitDestroyed",
    name: "Unit destroyed",
    from: ["unitDefeated"],
    fields: ["unitRef", "teamId", "sourceRef"],
    stages: ["after"]
  },
  {
    id: "targetMarked",
    name: "Target marked",
    from: ["statusApplied"],
    fields: ["unitRef", "teamId", "sourceRef", "statusId"],
    stages: ["after"]
  },
  {
    id: "statusApplied",
    name: "Status applied",
    from: ["statusApplied"],
    fields: ["unitRef", "teamId", "sourceRef", "statusId"],
    stages: ["after"]
  },
  {
    id: "repairCompleted",
    name: "Repair completed",
    from: ["healResolved"],
    fields: ["unitRef", "teamId", "sourceRef", "amount"],
    stages: ["after"]
  },
  {
    id: "factionChanged",
    name: "Faction relationship changed",
    from: ["unitChangedTeam"],
    fields: ["unitRef", "teamId"],
    stages: ["after"]
  }
];

export const REACTION_EVENT_TYPE_IDS = REACTION_EVENT_TYPES.map((entry) => entry.id);

export function reactionEventTypeById(id) {
  return REACTION_EVENT_TYPES.find((entry) => entry.id === id) || null;
}

/** Which reaction event types can fire at a given stage. Used to skip the
 *  whole window cheaply when nothing could possibly match. */
export function reactionEventTypesForStage(stage) {
  return REACTION_EVENT_TYPES.filter((entry) => entry.stages.includes(stage));
}

/** Simulation event types that produce any reaction event at all. Anything
 *  else short-circuits before the window opens. */
export const REACTIVE_SIMULATION_EVENTS = new Set(
  REACTION_EVENT_TYPES.flatMap((entry) => entry.from)
);

/** HP percentages worth an event. Matches the mission layer's set so a
 *  designer only has to learn one ladder. */
export const HP_THRESHOLDS = [75, 50, 25, 10];

/**
 * Derives reaction events from one simulation event at one stage.
 *
 * Pure: reads a small read-only view and returns plain data. `view.hpPercent`
 * is called at the moment of derivation, so an `after` threshold event sees
 * post-damage HP and a `before` one does not fire at all.
 *
 * @param simEvent  raw event from state.resolutionQueue
 * @param stage     "before" | "after"
 * @param view      { unitRefById, unitTeam, hpPercent, statusTags }
 */
export function deriveReactionEvents(simEvent, stage, view) {
  if (!REACTIVE_SIMULATION_EVENTS.has(simEvent.type)) return [];

  const out = [];
  const ref = (id) => (id == null ? null : view.unitRefById(id));
  const team = (id) => (id == null ? null : view.unitTeam(id));

  switch (simEvent.type) {
    case "unitActivated":
      if (stage === "after") {
        out.push({
          type: "activationStarted",
          unitRef: ref(simEvent.unitId),
          teamId: team(simEvent.unitId),
          unitId: simEvent.unitId
        });
      }
      break;

    case "turnEnded":
      if (stage === "after") {
        out.push({
          type: "activationEnded",
          unitRef: ref(simEvent.unitId),
          teamId: team(simEvent.unitId),
          unitId: simEvent.unitId
        });
      }
      break;

    case "abilityUsed": {
      const targetIds = simEvent.targetUnitIds || [];
      const payload = {
        unitRef: ref(simEvent.sourceUnitId),
        teamId: team(simEvent.sourceUnitId),
        unitId: simEvent.sourceUnitId,
        abilityId: simEvent.abilityId,
        targetRefs: targetIds.map(ref),
        targetUnitIds: targetIds.slice()
      };
      out.push({ type: stage === "before" ? "attackDeclared" : "attackResolved", ...payload });
      break;
    }

    case "damageResolved": {
      const subject = simEvent.targetUnitId;
      const payload = {
        unitRef: ref(subject),
        teamId: team(subject),
        unitId: subject,
        sourceRef: ref(simEvent.sourceUnitId),
        sourceUnitId: simEvent.sourceUnitId,
        amount: simEvent.appliedAmount == null ? simEvent.amount || 0 : simEvent.appliedAmount
      };
      out.push({ type: "unitDamaged", ...payload });
      if (stage === "after") {
        const percent = view.hpPercent(subject);
        for (const threshold of HP_THRESHOLDS) {
          if (percent <= threshold) {
            out.push({ type: "unitHpBelowThreshold", ...payload, percent: threshold });
          }
        }
      }
      break;
    }

    case "healResolved":
      if (stage === "after") {
        out.push({
          type: "repairCompleted",
          unitRef: ref(simEvent.targetUnitId),
          teamId: team(simEvent.targetUnitId),
          unitId: simEvent.targetUnitId,
          sourceRef: ref(simEvent.sourceUnitId),
          sourceUnitId: simEvent.sourceUnitId,
          // Applied, not requested: topping up an undamaged frame is not a
          // qualifying repair.
          amount: simEvent.appliedAmount == null ? simEvent.amount || 0 : simEvent.appliedAmount
        });
      }
      break;

    case "unitMoved":
    case "unitForcedMove":
      if (stage === "after") {
        const forced = simEvent.type === "unitForcedMove";
        out.push({
          type: "unitMoved",
          unitRef: ref(simEvent.unitId),
          teamId: team(simEvent.unitId),
          unitId: simEvent.unitId,
          // Who did the displacing. Self for a voluntary walk, which is what
          // makes "reacted because someone else put it there" expressible.
          sourceRef: forced ? ref(simEvent.sourceUnitId) : ref(simEvent.unitId),
          sourceUnitId: forced ? simEvent.sourceUnitId || null : simEvent.unitId,
          abilityId: simEvent.abilityId || null,
          from: simEvent.from,
          to: simEvent.to,
          tiles: simEvent.tiles == null ? null : simEvent.tiles,
          forced
        });
      }
      break;

    case "attackMissed":
      if (stage === "after") {
        out.push({
          type: "attackEvaded",
          // The subject is the unit that got out of the way; the source is
          // whoever shot at it. An evasion passive belongs to the subject.
          unitRef: ref(simEvent.targetUnitId),
          teamId: team(simEvent.targetUnitId),
          unitId: simEvent.targetUnitId,
          sourceRef: ref(simEvent.sourceUnitId),
          sourceUnitId: simEvent.sourceUnitId,
          abilityId: simEvent.abilityId || null
        });
      }
      break;

    case "unitDefeated":
      if (stage === "after") {
        out.push({
          type: "unitDestroyed",
          unitRef: ref(simEvent.unitId),
          teamId: team(simEvent.unitId),
          unitId: simEvent.unitId,
          sourceRef: ref(simEvent.sourceUnitId),
          sourceUnitId: simEvent.sourceUnitId || null,
          // The tile the destroyed unit was holding. This is the "opening"
          // an advance reaction moves into.
          tile: simEvent.tile || null
        });
      }
      break;

    case "statusApplied":
      if (stage === "after") {
        const payload = {
          unitRef: ref(simEvent.targetUnitId),
          teamId: team(simEvent.targetUnitId),
          unitId: simEvent.targetUnitId,
          sourceRef: ref(simEvent.sourceUnitId),
          sourceUnitId: simEvent.sourceUnitId,
          statusId: simEvent.statusId
        };
        out.push({ type: "statusApplied", ...payload });
        // `targetMarked` is derived from status data rather than from a
        // hardcoded status id: anything tagged `targeting` is a mark.
        if ((view.statusTags(simEvent.statusId) || []).includes("targeting")) {
          out.push({ type: "targetMarked", ...payload });
        }
      }
      break;

    case "unitChangedTeam":
      if (stage === "after") {
        out.push({
          type: "factionChanged",
          unitRef: ref(simEvent.unitId),
          teamId: team(simEvent.unitId),
          unitId: simEvent.unitId,
          from: simEvent.from,
          to: simEvent.to
        });
      }
      break;

    default:
      break;
  }

  return out;
}
