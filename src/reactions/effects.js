/* =========================================================================
 * REACTION EFFECTS
 *
 * What a reaction actually does. Every effect routes through the engine
 * adapter, which routes through the same combat machinery ordinary gameplay
 * uses — so a reaction attack produces real damage, real defeat events and
 * real log lines, and shows up identically in a save.
 *
 * A reaction never runs `executeCommand`. That path requires the unit to be
 * the active unit and consumes its activation; the entire point of an
 * out-of-turn response is that it does neither.
 *
 * Two effects here deliberately grant tempo rather than damage, and both are
 * bounded on purpose:
 *
 *   advanceIntoOpening   a movement, capped at the unit's own movement stat,
 *                        resolved through the real pathfinder. Never a teleport.
 *
 *   partialAction        exactly one *basic* ability, out of turn, at no
 *                        activation cost. Not a free activation: no movement,
 *                        no non-basic ability, no second action.
 * =======================================================================*/

/**
 * Shared preamble for the three intervention effects.
 *
 * All of them do the same two things before they do anything different: find
 * the declaration their triggering event named, and refuse politely if there
 * is not one. Refusing is the important half — a reaction whose effect returns
 * `{ ok: false }` is refunded and recorded, which is exactly right for "you
 * tried to intercept something that had already resolved".
 */
function interveningOn(ctx) {
  const declarationId = ctx.event.declarationId;
  if (!declarationId) {
    return { error: "that trigger does not carry an action to intervene in" };
  }
  if (!ctx.engine.proposeIntervention) {
    return { error: "this engine has no intervention model" };
  }
  return { declarationId };
}

export const REACTION_EFFECT_REGISTRY = {
  /**
   * No. That does not happen.
   *
   * The purest form of the defensive fantasy, and the one that needs the least
   * explanation: the enemy chose an action, and it does not occur. They still
   * paid for it — see the cost-commit rule in App.jsx — which is what stops
   * this from being a way to farm an opponent's turn for free.
   */
  cancelTriggeringAction: {
    name: "Cancel the declared action",
    fields: [],
    summary: "The action that triggered this reaction never resolves. Its cost is still spent.",
    run(effect, ctx) {
      const found = interveningOn(ctx);
      if (found.error) return { ok: false, reason: found.error };
      const result = ctx.engine.proposeIntervention(ctx.state, found.declarationId, {
        kind: "cancel",
        byUnitId: ctx.reactorId
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, detail: "stopped " + (ctx.event.abilityId || "the action") };
    }
  },

  /**
   * You are dealing with me.
   *
   * Pulls the declared action onto a different target — by default the
   * reactor, which is the taunt, the body-block and the parry all at once.
   * `target: "subject"` points it at the unit the event happened to instead,
   * which is how a protective ability shields a specific ally.
   *
   * The new target is revalidated in full at resolution time: range, line of
   * sight, filters and concealment all still apply. A defender cannot drag a
   * short-ranged swing across the map by standing far away and volunteering.
   */
  redirectTriggeringAction: {
    name: "Redirect the declared action",
    fields: ["target"],
    summary: "The action resolves against the reactor (or another unit) instead.",
    validate(effect) {
      if (effect.target && !["self", "subject", "source"].includes(effect.target)) {
        return ['redirectTriggeringAction target must be "self", "subject" or "source".'];
      }
      return [];
    },
    run(effect, ctx) {
      const found = interveningOn(ctx);
      if (found.error) return { ok: false, reason: found.error };
      if (ctx.event.redirectable === false) {
        return { ok: false, reason: "that action cannot be pointed at somebody else" };
      }
      const which = effect.target || "self";
      const targetId = which === "self" ? ctx.reactorId : ctx.eventUnitId(which);
      if (!targetId || !ctx.unitIsAlive(targetId)) {
        return { ok: false, reason: "no living unit to take it instead" };
      }
      const result = ctx.engine.proposeIntervention(ctx.state, found.declarationId, {
        kind: "redirect",
        byUnitId: ctx.reactorId,
        targetUnitId: targetId
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, detail: "took " + (ctx.event.abilityId || "the action") + " instead" };
    }
  },

  /**
   * You are dealing with me *first*.
   *
   * The reactor attacks the declared actor, and the declared action never
   * resolves. Deliberately one effect rather than two, because "hit them and
   * also stop them" composed out of an attack effect and a cancel effect would
   * be two reactions racing for one declaration, and the loser would fire into
   * the void.
   *
   * The order inside is the whole design: the intervention is proposed *first*
   * and the attack only happens if it was accepted. An intercept that was
   * refused — because something else already intervened, or the chain is
   * exhausted — costs nothing and does nothing, rather than dealing damage for
   * an interception that did not occur.
   */
  interceptAction: {
    name: "Intercept",
    fields: ["abilityId", "power", "formula"],
    summary: "Attack the declared actor; the action they declared never resolves.",
    run(effect, ctx) {
      const found = interveningOn(ctx);
      if (found.error) return { ok: false, reason: found.error };
      const actorId = ctx.eventUnitId("source");
      if (!actorId) return { ok: false, reason: "the event named no actor" };
      if (!ctx.unitIsAlive(actorId)) return { ok: false, reason: "the actor is already gone" };
      if (!ctx.isHostile(ctx.reactorId, actorId)) {
        return { ok: false, reason: "the actor is not an enemy" };
      }

      const result = ctx.engine.proposeIntervention(ctx.state, found.declarationId, {
        kind: "replace",
        byUnitId: ctx.reactorId
      });
      if (!result.ok) return { ok: false, reason: result.reason };

      ctx.engine.scriptedAttack(ctx.state, {
        sourceUnitId: ctx.reactorId,
        targetUnitIds: [actorId],
        abilityId: effect.abilityId || null,
        power: effect.power,
        formula: effect.formula
      });
      return { ok: true, detail: "intercepted " + ctx.unitRef(actorId) };
    }
  },

  /**
   * Attack a unit named by the triggering event.
   *
   * `targetFrom` picks which unit the event supplies: "subject" (the thing the
   * event happened to — a marked enemy) or "source" (whoever caused it — a
   * counterattack against the attacker).
   */
  reactionAttack: {
    name: "Reaction attack",
    fields: ["targetFrom", "abilityId", "power", "formula"],
    summary: "Resolves a real attack out of turn against a unit from the event.",
    validate(effect) {
      if (effect.targetFrom && !["subject", "source"].includes(effect.targetFrom)) {
        return ['reactionAttack targetFrom must be "subject" or "source".'];
      }
      return [];
    },
    run(effect, ctx) {
      const targetId = ctx.eventUnitId(effect.targetFrom || "subject");
      if (!targetId) return { ok: false, reason: "the event named no target" };
      if (!ctx.unitIsAlive(targetId)) return { ok: false, reason: "the target is already gone" };
      if (!ctx.isHostile(ctx.reactorId, targetId)) {
        return { ok: false, reason: "the target is no longer hostile" };
      }
      ctx.engine.scriptedAttack(ctx.state, {
        sourceUnitId: ctx.reactorId,
        targetUnitIds: [targetId],
        abilityId: effect.abilityId || null,
        power: effect.power,
        formula: effect.formula
      });
      return { ok: true, detail: "attacked " + ctx.unitRef(targetId) };
    }
  },

  /**
   * Move toward the space an event created — the tile a destroyed unit was
   * holding, or the position of the event's subject.
   *
   * Resolves through the real pathfinder with the mover's own movement budget.
   * If the exact tile is unreachable or occupied it takes the closest legal
   * tile it can actually reach, and reports having done nothing if there is
   * none. It never teleports and never fails the simulation.
   */
  advanceIntoOpening: {
    name: "Advance into the opening",
    fields: ["targetFrom", "maxTiles"],
    summary: "A legal move toward the tile the event freed up. Never a teleport.",
    run(effect, ctx) {
      const tile = ctx.eventTile(effect.targetFrom || "subject");
      if (!tile) return { ok: false, reason: "the event named no position" };
      const budget = effect.maxTiles == null ? ctx.reactorMovement() : effect.maxTiles;
      const result = ctx.engine.moveTowardTile(ctx.state, ctx.reactorId, tile, { budget });
      if (!result || !result.moved) {
        return { ok: false, reason: result && result.reason ? result.reason : "no legal ground to advance onto" };
      }
      return { ok: true, detail: "advanced " + result.tiles + " tile(s)" };
    }
  },

  /**
   * Grants one immediate basic action, out of turn.
   *
   * Scope is deliberately narrow — this is a tempo grant, not a second
   * activation. The recipient uses exactly one ability flagged `basic` in
   * content, against a target chosen by the same deterministic scorer the AI
   * uses, and nothing else. If it has no legal basic action the reaction
   * reports that instead of silently doing nothing expensive.
   */
  partialAction: {
    name: "Partial action",
    fields: ["recipientFrom", "grants"],
    summary: "One basic ability, out of turn, at no activation cost. Not a free turn.",
    validate(effect) {
      const grants = effect.grants || "basicAbility";
      if (!["basicAbility", "move"].includes(grants)) {
        return ['partialAction grants must be "basicAbility" or "move".'];
      }
      return [];
    },
    run(effect, ctx) {
      const recipientId = ctx.eventUnitId(effect.recipientFrom || "subject");
      if (!recipientId) return { ok: false, reason: "the event named no recipient" };
      if (!ctx.unitIsActionable(recipientId)) {
        return { ok: false, reason: "the recipient cannot act" };
      }

      if ((effect.grants || "basicAbility") === "move") {
        const result = ctx.engine.moveTowardNearestHostile(ctx.state, recipientId, {
          budget: Math.max(1, Math.floor(ctx.unitMovement(recipientId) / 2))
        });
        if (!result || !result.moved) return { ok: false, reason: "nowhere legal to reposition" };
        return { ok: true, detail: ctx.unitRef(recipientId) + " repositioned" };
      }

      const choice = ctx.engine.chooseBasicAction(ctx.state, recipientId);
      if (!choice) return { ok: false, reason: "no legal basic action available" };
      ctx.engine.scriptedAttack(ctx.state, {
        sourceUnitId: recipientId,
        targetUnitIds: [choice.targetUnitId],
        abilityId: choice.abilityId
      });
      return {
        ok: true,
        detail: ctx.unitRef(recipientId) + " takes a partial action (" + choice.abilityId + ")"
      };
    }
  },

  /** Applies a status through the normal effect pipeline. Covers guards,
   *  braces and marks without a bespoke effect per case. */
  reactionStatus: {
    name: "Apply status",
    fields: ["statusId", "targetFrom"],
    summary: "Applies a status to the reactor or to a unit from the event.",
    validate(effect) {
      return effect.statusId ? [] : ["reactionStatus needs a statusId."];
    },
    run(effect, ctx) {
      const targetId =
        effect.targetFrom === "self" || !effect.targetFrom
          ? ctx.reactorId
          : ctx.eventUnitId(effect.targetFrom);
      if (!targetId || !ctx.unitIsAlive(targetId)) {
        return { ok: false, reason: "no living target for the status" };
      }
      ctx.engine.applyStatus(ctx.state, ctx.reactorId, [targetId], effect.statusId);
      return { ok: true, detail: effect.statusId + " on " + ctx.unitRef(targetId) };
    }
  },

  /** Repairs a unit from the event. */
  reactionRepair: {
    name: "Reaction repair",
    fields: ["targetFrom", "amount"],
    summary: "Resolves a real repair out of turn.",
    run(effect, ctx) {
      const targetId = ctx.eventUnitId(effect.targetFrom || "subject");
      if (!targetId || !ctx.unitIsAlive(targetId)) {
        return { ok: false, reason: "no living target to repair" };
      }
      ctx.engine.scriptedRepair(ctx.state, {
        sourceUnitId: ctx.reactorId,
        targetUnitIds: [targetId],
        amount: effect.amount == null ? 30 : effect.amount
      });
      return { ok: true, detail: "repaired " + ctx.unitRef(targetId) };
    }
  },

  /**
   * Moves a unit's next activation earlier or later on the real timeline.
   *
   * The generic form of "a clean kill leaves you already moving" and "that
   * shot took a long time to line up". It routes through the engine's own
   * initiative arithmetic rather than writing `nextActionTime` directly, so a
   * fast frame and a slow one feel the same adjustment differently — which is
   * the whole reason the timeline is continuous.
   *
   * Clamped at both ends: an activation can never be pulled earlier than now,
   * and a single adjustment cannot exceed a configured ceiling. Unbounded
   * hastening is how you get a unit that acts forever.
   */
  modifyTurnDelay: {
    name: "Modify turn delay",
    fields: ["target", "hasten", "delay"],
    summary: "Pulls a unit's next activation earlier, or pushes it later.",
    validate(effect) {
      const problems = [];
      const hasten = Number(effect.hasten || 0);
      const delay = Number(effect.delay || 0);
      if (!hasten && !delay) problems.push("modifyTurnDelay needs a hasten or a delay.");
      if (hasten < 0 || delay < 0) {
        problems.push("modifyTurnDelay takes positive amounts; use the other field to reverse it.");
      }
      if (effect.target && !["self", "subject", "source"].includes(effect.target)) {
        return problems.concat(['modifyTurnDelay target must be "self", "subject" or "source".']);
      }
      return problems;
    },
    run(effect, ctx) {
      const which = effect.target || "self";
      const targetId = which === "self" ? ctx.reactorId : ctx.eventUnitId(which);
      if (!targetId || !ctx.unitIsAlive(targetId)) {
        return { ok: false, reason: "no living unit to reschedule" };
      }
      const delta = Number(effect.delay || 0) - Number(effect.hasten || 0);
      if (!delta) return { ok: false, reason: "no adjustment requested" };
      const result = ctx.engine.modifyTurnDelay(ctx.state, targetId, delta, {
        sourceUnitId: ctx.reactorId
      });
      if (!result || !result.applied) {
        return { ok: false, reason: (result && result.reason) || "the timeline did not move" };
      }
      return {
        ok: true,
        detail:
          ctx.unitRef(targetId) + (delta < 0 ? " acts sooner by " : " is delayed by ") +
          Math.abs(Math.round(result.applied))
      };
    }
  },

  /** Restores a resource. The counterpart to `cost`, so a skill can give
   *  tempo back rather than only spend it. */
  restoreReactionResource: {
    name: "Restore resource",
    fields: ["resourceId", "amount", "target"],
    summary: "Refunds points into any resource the reactor or the event names.",
    validate(effect) {
      return effect.resourceId ? [] : ["restoreReactionResource needs a resourceId."];
    },
    run(effect, ctx) {
      const amount = effect.amount == null ? 1 : effect.amount;
      const which = effect.target || "self";
      const targetId = which === "self" ? ctx.reactorId : ctx.eventUnitId(which);
      const restored = ctx.gainResource(effect.resourceId, targetId, amount);
      if (!restored) return { ok: false, reason: "nothing to restore" };
      return { ok: true, detail: "restored " + restored + " " + effect.resourceId };
    }
  }
};

export const REACTION_EFFECT_IDS = Object.keys(REACTION_EFFECT_REGISTRY);

export function reactionEffectById(id) {
  return REACTION_EFFECT_REGISTRY[id] || null;
}

export function validateReactionEffect(effect, path) {
  const where = path || "effect";
  if (!effect || typeof effect !== "object") return [where + " must be an object."];
  const definition = reactionEffectById(effect.type);
  if (!definition) {
    return [
      where + ' uses unknown reaction effect "' + effect.type + '". Available: ' + REACTION_EFFECT_IDS.join(", ")
    ];
  }
  const problems = definition.validate ? definition.validate(effect) || [] : [];
  return problems.map((message) => where + ": " + message);
}
