/* =========================================================================
 * PROPAGATION
 *
 * A chain of targets, each one chosen because of where the last one is
 * standing right now.
 *
 * The engine already had area targeting: a shape, centred on a tile, listing
 * everything inside it. Every target in that model sits at a fixed offset from
 * one point, which is why it cannot express the thing a chain needs —
 *
 *     hit A ─▶ find something near A ─▶ hit B ─▶ find something near B ─▶ …
 *
 * — where the second target's legality depends on the *first target's* live
 * position rather than on the caster's. That dependency is the whole mechanic:
 * it is what makes a clustered formation a mistake, and what lets one operator
 * set up another operator's payoff by moving a single enemy two tiles.
 *
 * So this module adds a search, not a targeting system. It walks from node to
 * node asking the engine's own distance, sight and eligibility questions
 * through an adapter, and it never looks at a map, a status or a content id.
 * There is deliberately no second distance metric and no second line-of-sight
 * model: a plan that says two units can arc is making the *engine's* claim.
 *
 * Determinism is a hard requirement, not a nicety — the same battle state must
 * produce the same chain in a replay, in a preview and in a test. Every
 * selection is therefore fully ordered, with a stable final tie-break, and no
 * randomness enters at any point.
 *
 * Pure data and pure functions. No engine imports, no React, no content ids.
 * =======================================================================*/

/**
 * The absolute ceiling on arcs, whatever content asks for.
 *
 * Authored data is allowed to be wrong. This is the difference between a
 * mistyped hop count producing a silly chain and producing a hung tab.
 */
export const MAX_PROPAGATION_HOPS = 24;

/* ---------------------------------------------------------------
 * SELECTION POLICIES
 *
 * How the chain decides where to go next, given every legal candidate.
 *
 * A registry rather than a parameter, so adding "arc to the most wounded" is
 * an entry here plus a word in a JSON file. It is deliberately *not* a scoring
 * language: content picks a named policy, it does not write one. An AI search
 * over possible chains is a different problem and does not belong here.
 *
 * Every policy must be a total order. `id` is the last comparison in all of
 * them, which is what makes the result stable when two candidates are
 * otherwise identical.
 * -------------------------------------------------------------*/

export const SELECTION_POLICIES = {
  nearest: {
    label: "Nearest",
    summary: "The closest legal target, ties broken by unit id.",
    compare: (a, b) => a.distance - b.distance || compareIds(a, b)
  },
  nearestThenWeakest: {
    label: "Nearest, then weakest",
    summary:
      "The closest legal target; among equally close ones, the one with the " +
      "least health left. Ties broken by unit id.",
    compare: (a, b) => a.distance - b.distance || a.weight - b.weight || compareIds(a, b)
  }
};

export const SELECTION_POLICY_IDS = Object.keys(SELECTION_POLICIES);

/** The final tie-break. Ids are stable across saves, so this is too. */
function compareIds(a, b) {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function selectionPolicy(id) {
  return SELECTION_POLICIES[id] || SELECTION_POLICIES.nearest;
}

/* ---------------------------------------------------------------
 * PLANNING
 * -------------------------------------------------------------*/

/**
 * Walks a chain outward from an initial target.
 *
 * `deps` is the engine adapter. Every question about the battlefield is asked
 * through it, and none of the answers are recomputed here:
 *
 *   nodes()                  → [{ id, x, y, weight }]  everything that could be a node
 *   distance(fromId, toId)   → number                  the engine's own metric
 *   connected(fromId, toId)  → boolean                 the engine's own sight check
 *   eligible(id)             → { ok, reason }          relationship, filters, alive, detection
 *   hopRadius(fromId, toId)  → number                  how far *this* arc may reach
 *
 * `hopRadius` is a function rather than a number so that a unit can be easier
 * to arc to or from than another one. That is how a conductive status composes
 * without this module ever hearing the word.
 *
 * A plan is returned whether or not it worked. `legal` says whether it can
 * run; `terminationReason` says why it stopped. A preview that could only
 * render successful chains would be unable to show the player *why* their
 * chain stops one enemy short, which is exactly the information that makes
 * repositioning a decision rather than a guess.
 */
export function planPropagation(sourceUnitId, initialTargetId, deps, options) {
  const opts = options || {};
  const limits = {
    maxHops: clampHops(opts.maxHops),
    allowRepeat: opts.allowRepeat === true,
    includeSource: opts.includeSource === true,
    selection: opts.selection || "nearest"
  };
  const policy = selectionPolicy(limits.selection);

  const plan = {
    sourceUnitId,
    initialTargetId: initialTargetId || null,
    /** Node 0 is the initial target; every later node is one arc further. */
    nodes: [],
    order: [],
    rejected: [],
    maxHops: limits.maxHops,
    selection: limits.selection,
    hops: 0,
    legal: false,
    initialLegal: false,
    initialReason: null,
    terminationReason: "noInitialTarget"
  };

  if (!initialTargetId) {
    plan.initialReason = "no initial target";
    return plan;
  }
  const initialCheck = deps.eligible(initialTargetId);
  if (!initialCheck.ok) {
    plan.initialReason = initialCheck.reason || "the initial target is not legal";
    plan.rejected.push({
      id: initialTargetId,
      hop: 0,
      fromId: sourceUnitId,
      distance: null,
      reason: plan.initialReason
    });
    return plan;
  }

  plan.initialLegal = true;
  plan.legal = true;
  plan.nodes.push({
    id: initialTargetId,
    hop: 0,
    fromId: null,
    distance: 0,
    radius: 0
  });
  plan.order.push(initialTargetId);

  const visited = new Set([initialTargetId]);
  if (!limits.includeSource) visited.add(sourceUnitId);

  let current = initialTargetId;
  plan.terminationReason = "hopLimit";

  for (let hop = 1; hop <= limits.maxHops; hop += 1) {
    const candidates = [];
    for (const node of deps.nodes()) {
      if (node.id === current) continue;
      // `allowRepeat` still cannot revisit the node the arc is standing on,
      // because an arc of length zero is not a hop and would spin forever.
      if (!limits.allowRepeat && visited.has(node.id)) {
        plan.rejected.push({
          id: node.id,
          hop,
          fromId: current,
          distance: deps.distance(current, node.id),
          reason: "already in the chain"
        });
        continue;
      }
      if (!limits.includeSource && node.id === sourceUnitId) continue;

      const check = deps.eligible(node.id);
      if (!check.ok) {
        plan.rejected.push({
          id: node.id,
          hop,
          fromId: current,
          distance: deps.distance(current, node.id),
          reason: check.reason || "not a legal target"
        });
        continue;
      }

      const distance = deps.distance(current, node.id);
      const radius = deps.hopRadius(current, node.id);
      if (distance > radius) {
        plan.rejected.push({
          id: node.id,
          hop,
          fromId: current,
          distance,
          reason: "out of arc range (" + distance + " > " + radius + ")"
        });
        continue;
      }
      if (deps.connected && !deps.connected(current, node.id)) {
        plan.rejected.push({
          id: node.id,
          hop,
          fromId: current,
          distance,
          reason: "nothing to arc through"
        });
        continue;
      }
      candidates.push({
        id: node.id,
        distance,
        radius,
        weight: node.weight == null ? 0 : node.weight
      });
    }

    if (!candidates.length) {
      plan.terminationReason = "noEligibleTarget";
      break;
    }

    candidates.sort(policy.compare);
    const chosen = candidates[0];
    plan.nodes.push({
      id: chosen.id,
      hop,
      fromId: current,
      distance: chosen.distance,
      radius: chosen.radius
    });
    plan.order.push(chosen.id);
    visited.add(chosen.id);
    current = chosen.id;
  }

  plan.hops = plan.nodes.length - 1;
  return plan;
}

/** Requested hops, bounded by the module's own ceiling. */
function clampHops(requested) {
  const value = requested == null ? 1 : Math.floor(Number(requested));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_PROPAGATION_HOPS, value);
}

/* ---------------------------------------------------------------
 * RUNTIME CONTEXT
 *
 * What conditions and effects may read while a chain is resolving. Plain
 * serializable values, so a save taken mid-chain resumes with the same answers
 * and a replay reproduces them.
 * -------------------------------------------------------------*/

export function createPropagationContext(plan, options) {
  return {
    sourceUnitId: plan.sourceUnitId,
    abilityId: (options && options.abilityId) || null,
    initialTargetId: plan.initialTargetId,
    plannedOrder: plan.order.slice(),
    plannedHops: plan.hops,
    terminationReason: plan.terminationReason,
    /** Filled in as the chain runs. */
    resolved: [],
    hop: 0,
    hopDistance: 0,
    previousTargetId: null,
    currentTargetId: null,
    kills: 0,
    interrupted: false,
    interruptReason: null
  };
}

/** Advances the context onto one node. Pure bookkeeping. */
export function advancePropagation(context, node) {
  context.hop = node.hop;
  context.hopDistance = node.distance;
  context.previousTargetId = node.fromId;
  context.currentTargetId = node.id;
  context.resolved.push(node.id);
  return context;
}

/** A one-line explanation of where a chain stopped, for a log or a panel. */
export function describeTermination(plan) {
  switch (plan.terminationReason) {
    case "noInitialTarget":
      return plan.initialReason || "no initial target";
    case "hopLimit":
      return "reached its limit of " + plan.maxHops + (plan.maxHops === 1 ? " arc" : " arcs");
    case "noEligibleTarget":
      return "nothing else in range";
    default:
      return plan.terminationReason || "";
  }
}
