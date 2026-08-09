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

export const REACTION_EFFECT_REGISTRY = {
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

  /** Restores reaction capacity or a shared pool. The counterpart to `cost`,
   *  so a skill can eventually give tempo back rather than only spend it. */
  restoreReactionResource: {
    name: "Restore reaction resource",
    fields: ["poolId", "amount", "target"],
    summary: "Refunds points into a shared pool or a unit's own capacity.",
    run(effect, ctx) {
      const amount = effect.amount == null ? 1 : effect.amount;
      if (effect.poolId) {
        const restored = ctx.restorePool(effect.poolId, amount);
        return { ok: restored > 0, detail: "restored " + restored + " to " + effect.poolId };
      }
      const targetId = effect.target === "self" || !effect.target ? ctx.reactorId : ctx.eventUnitId(effect.target);
      if (!targetId) return { ok: false, reason: "no target for the refund" };
      ctx.restoreUnitCapacity(targetId, amount);
      return { ok: true, detail: "restored capacity to " + ctx.unitRef(targetId) };
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
