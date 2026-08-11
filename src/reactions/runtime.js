/* =========================================================================
 * REACTION RUNTIME
 *
 * Out-of-turn responses to authoritative simulation events.
 *
 * Lifecycle, once per (event, stage):
 *
 *   1. derive   simulation event -> reaction events (events.js)
 *   2. discover indexed lookup by trigger type — never a scan of every unit
 *                against every ability
 *   3. filter   conditions + economy + actor legality
 *   4. order    mandatory, then priority, then speed, then creation order
 *   5. choose   automatic and mandatory resolve immediately; optional ones go
 *               to their controller (deterministic policy, AI hook, or a
 *               suspended window awaiting a player)
 *   6. pay      cost is deducted and limit counters recorded
 *   7. execute  effects run through the engine adapter, re-checking legality
 *               immediately beforehand
 *   8. cascade  the events those effects produce open their own windows,
 *               bounded by depth
 *
 * Everything lives in `state.reactions`, which is plain serializable data, so
 * a save taken mid-chain resumes exactly where it stopped and a replay from
 * the same seed reproduces the same sequence.
 * =======================================================================*/

import { deriveReactionEvents, REACTIVE_SIMULATION_EVENTS } from "./events.js";
import { evaluateReactionCondition } from "./conditions.js";
import { reactionEffectById } from "./effects.js";
import {
  createReactionEconomyState,
  canAfford,
  payCost,
  refundCost,
  describeCost
} from "./economy.js";
import {
  createLinkState,
  evaluateLinks,
  isLinkActive,
  setLinkEnabled,
  setLinkUnlocked,
  resourceOwnership,
  describeLinks
} from "./links.js";
import {
  normalizeResourceDefinition,
  setResourceAvailable,
  regenerateOnActivation,
  gainResource,
  describeResources
} from "../combat/resources.js";
import { describeIntervention } from "../combat/interventions.js";

export const REACTION_LIMITS = {
  /** How deep a cascade may go. A reaction that triggers a reaction that
   *  triggers a reaction is legitimate; ten levels is a bug. */
  maxDepth: 4,
  /** Reactions executed while resolving one simulation event, across all
   *  stages and all cascades under it. */
  maxPerEvent: 12,
  /** Reactions executed in one battle before the runtime decides something
   *  is wrong and stops offering. */
  maxPerBattle: 2000
};

/** Deterministic policies for resolving an optional reaction without a human.
 *  Used headlessly, in replay, and by the AI hook's default. */
export const AUTO_POLICIES = ["takeFirst", "decline"];

/* ---------------------------------------------------------------
 * STATE
 * -------------------------------------------------------------*/

export function createReactionState(content, options) {
  const links = createLinkState(content.links, options);
  return {
    enabled: true,
    economy: createReactionEconomyState(),
    links,
    /** Suspended optional-reaction choice, or null. */
    window: null,
    windowSeq: 0,
    eventSeq: 0,
    depth: 0,
    executedThisEvent: 0,
    executedThisBattle: 0,
    /** Recent resolutions, for the HUD and for tests. Bounded. */
    log: [],
    /** Deterministic policy when no human is present. */
    autoPolicy: (options && options.autoPolicy) || "takeFirst",
    autoResolve: !(options && options.autoResolve === false)
  };
}

/* ---------------------------------------------------------------
 * DISCOVERY INDEX
 *
 * Built once per battle from the content table and cached on the deps object.
 * Discovery is then O(reactions declared for this trigger), not O(units x
 * abilities x events).
 * -------------------------------------------------------------*/

export function buildReactionIndex(content) {
  const byTrigger = {};
  for (const reaction of content.reactions || []) {
    const trigger = reaction.trigger;
    if (!byTrigger[trigger]) byTrigger[trigger] = [];
    byTrigger[trigger].push(reaction);
  }
  for (const list of Object.values(byTrigger)) {
    // Stable order before any dynamic sorting, so ties never depend on
    // object-key iteration order.
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  const resourceById = Object.fromEntries(
    (content.resources || []).map((entry) => [entry.id, entry])
  );

  const reactionsByLink = {};
  for (const link of content.links || []) {
    reactionsByLink[link.id] = link.reactions || [];
  }
  const linkByReaction = {};
  for (const [linkId, ids] of Object.entries(reactionsByLink)) {
    for (const id of ids) linkByReaction[id] = linkId;
  }

  return {
    byTrigger,
    linkByReaction,
    triggers: new Set(Object.keys(byTrigger)),
    reactionById: Object.fromEntries((content.reactions || []).map((entry) => [entry.id, entry])),
    resourceById,
    resourceDefinitions: (content.resources || []).map((entry) =>
      normalizeResourceDefinition(entry)
    )
  };
}

/* ---------------------------------------------------------------
 * VIEW
 *
 * Everything the runtime needs to know about the battle, funnelled through the
 * engine adapter so this module never imports the simulation.
 * -------------------------------------------------------------*/

function buildView(state, deps) {
  const engine = deps.engine;
  return {
    unitIdByRef: (ref) => {
      if (!ref) return null;
      for (const id of state.unitOrder) {
        if (state.units[id].ref === ref) return id;
      }
      return null;
    },
    unitRefById: (id) => (state.units[id] ? state.units[id].ref || id : id),
    unitTeam: (id) => (state.units[id] ? state.units[id].teamId : null),
    unitIsAlive: (id) => !!(state.units[id] && state.units[id].alive),
    unitIsActionable: (id) => {
      const unit = state.units[id];
      return !!(unit && unit.alive && !unit.dormant);
    },
    relationship: (a, b) => engine.relationship(state, a, b),
    hpPercent: (id) => engine.hpPercent(state, id),
    statusTags: (statusId) => engine.statusTags(statusId),
    movement: (id) => engine.unitMovement(state, id),
    distance: (a, b) => engine.distance(state, a, b),
    hasStatus: (id, statusId) => engine.unitHasStatus(state, id, statusId),
    speed: (id) => engine.unitSpeed(state, id),
    teamController: (teamId) => {
      const team = state.teams.find((entry) => entry.id === teamId);
      return team ? team.controller || "ai" : "ai";
    },
    knowledgeState: (viewerId, subjectId) =>
      engine.knowledgeState ? engine.knowledgeState(state, viewerId, subjectId) : "acquired",
    canSeeTile: (viewerId, tile) =>
      !!tile && (engine.canSeeTile ? engine.canSeeTile(state, viewerId, tile) : true)
  };
}

/* ---------------------------------------------------------------
 * LINK MAINTENANCE
 * -------------------------------------------------------------*/

/** Re-evaluates links and syncs shared-pool availability. Idempotent and
 *  cheap; call it after anything that could change the answer. */
export function refreshLinks(state, deps) {
  const reactions = state.reactions;
  if (!reactions) return [];
  const view = buildView(state, deps);
  const changed = evaluateLinks(reactions.links, deps.content.links, view);

  // A resource that names a link is usable exactly while that link holds. The
  // resource layer knows nothing about links; the link layer knows nothing
  // about balances. This loop is the only place the two meet.
  for (const definition of deps.index.resourceDefinitions) {
    if (!definition.linkId) continue;
    const active = isLinkActive(reactions.links, definition.linkId);
    const flipped = setResourceAvailable(state, definition, active);
    if (flipped) {
      const link = (deps.content.links || []).find((entry) => entry.id === definition.linkId);
      deps.engine.logLine(
        state,
        "reactionLink",
        ((link && link.name) || definition.linkId) + (active ? " is available" : " is unavailable") +
          (active ? "" : " — " + (reactions.links[definition.linkId] || {}).reason),
        { linkId: definition.linkId, active }
      );
    }
  }
  return changed;
}

export function setLinkStateById(state, deps, linkId, options) {
  const reactions = state.reactions;
  if (!reactions || !reactions.links[linkId]) return false;
  let changed = false;
  if (options.unlocked !== undefined) changed = setLinkUnlocked(reactions.links, linkId, options.unlocked) || changed;
  if (options.enabled !== undefined) changed = setLinkEnabled(reactions.links, linkId, options.enabled) || changed;
  refreshLinks(state, deps);
  return changed;
}

/* ---------------------------------------------------------------
 * DISCOVERY AND FILTERING
 * -------------------------------------------------------------*/

/**
 * Who this reaction is offered to.
 *
 * An owned reaction belongs to one authored unit. An unowned one is offered to
 * every unit that satisfies `requires` — which is how a stance-based response
 * works without the content restating it per operator.
 */
function candidateReactorIds(reaction, state, view) {
  if (reaction.owner) {
    const id = view.unitIdByRef(reaction.owner);
    return id ? [id] : [];
  }
  if (!reaction.requires) return [];
  return state.unitOrder.slice();
}

/** Cheap gate that decides whether a unit is a candidate at all. */
function meetsRequirements(reaction, reactorId, view) {
  const requires = reaction.requires;
  if (!requires) return true;
  if (requires.status && !view.hasStatus(reactorId, requires.status)) return false;
  if (requires.team && view.unitTeam(reactorId) !== requires.team) return false;
  return true;
}

/** A reaction blocked only by cost is still worth showing, so the player can
 *  see what the shortage cost them. Anything else simply does not apply. */
function offerableWhenUnaffordable(reaction) {
  return !reaction.mandatory && !reaction.automatic;
}

/**
 * Which reaction effects change the action that triggered them.
 *
 * The runtime does not implement interventions and does not want to. It only
 * needs to know that these three do something a prompt must explain: "Intercept
 * — 1 Poise" and nothing else is asking the player to gamble, and the
 * consequence is the entire decision.
 */
const INTERVENTION_EFFECT_KINDS = {
  cancelTriggeringAction: "cancel",
  redirectTriggeringAction: "redirect",
  interceptAction: "replace"
};

function interventionPreview(reaction, event, reactorRef) {
  const kind = INTERVENTION_EFFECT_KINDS[reaction.effect && reaction.effect.type];
  if (!kind) return null;
  return {
    kind,
    text: describeIntervention(kind, {
      actionName: event.actionName || event.abilityId || "the action",
      actorName: event.unitRef || "the attacker",
      targetName: reactorRef
    })
  };
}

function costContext(state, deps, reactorId, event) {
  const unit = state.units[reactorId];
  return {
    unitId: reactorId,
    teamId: unit ? unit.teamId : null,
    eventSeq: event.__seq,
    chainId: event.cause ? event.cause.chainId : null,
    activationCount: state.activationCount,
    resourceById: (id) => deps.index.resourceById[id] || null
  };
}

function buildConditionContext(state, deps, view, reaction, reactorId, event) {
  return {
    event,
    reactorId,
    relationship: view.relationship,
    linkActive: (linkId) => isLinkActive(state.reactions.links, linkId),
    reactorIsActionable: () => view.unitIsActionable(reactorId),
    reactorHpPercent: () => view.hpPercent(reactorId),
    reactorHasStatus: (statusId) => view.hasStatus(reactorId, statusId),
    unitHasStatus: (id, statusId) => (id ? view.hasStatus(id, statusId) : false),
    unitIsAlive: (id) => view.unitIsAlive(id),
    unitIsActionable: (id) => (id ? view.unitIsActionable(id) : false),
    distanceTo: (id) => (id ? view.distance(reactorId, id) : null),
    missionFact: (fact) => (state.mission ? state.mission.facts[fact] : undefined),
    // What the *reactor's faction* believes about a unit. A reaction gated on
    // knowledge cannot fire on something its side has not noticed, which is
    // what stops an out-of-turn response from becoming a detection oracle.
    knowledgeState: (id) => view.knowledgeState(reactorId, id),
    // Exposure, asked from the reactor's own position. See the
    // `subjectBecameExposed` condition for why this is a relation rather than
    // a cached cover flag.
    canSeeTile: (tile) => view.canSeeTile(reactorId, tile),
    eventTile: (which) => {
      if (which === "from") return event.from || null;
      if (which === "to") return event.to || event.tile || null;
      return event.tile || null;
    }
  };
}

/**
 * Every reaction that could legally fire for this reaction event, already
 * ordered. Pure — discovery never mutates.
 */
export function discoverReactions(state, deps, event) {
  const reactions = state.reactions;
  const index = deps.index;
  const candidates = index.byTrigger[event.type];
  if (!candidates || !candidates.length) return [];

  const view = buildView(state, deps);
  const offers = [];

  for (const reaction of candidates) {
    const linkId = index.linkByReaction[reaction.id];
    // A reaction owned by an inactive link is not merely unaffordable, it does
    // not exist. This is the whole narrative gate.
    if (linkId && !isLinkActive(reactions.links, linkId)) continue;

    for (const reactorId of candidateReactorIds(reaction, state, view)) {
      if (!view.unitIsActionable(reactorId)) continue;
      // `requires` is the cheap pre-filter an unowned reaction needs: a
      // prepared-stance reaction is offered to whoever holds the stance,
      // rather than being written once per unit that might.
      if (!meetsRequirements(reaction, reactorId, view)) continue;
      // Reacting to your own action is legitimate and common — Reyes finishes
      // a repair and hands the repaired frame a partial action. The loop risk
      // is handled where it belongs: one reaction per event instance, plus the
      // depth ceiling on cascades. Authors narrow further with conditions.

      const ctx = buildConditionContext(state, deps, view, reaction, reactorId, event);
      if (!evaluateReactionCondition(reaction.conditions, ctx)) continue;

      const affordability = canAfford(state, reactions.economy, reaction, costContext(state, deps, reactorId, event));
      // A reaction blocked only by its cost is still offered, greyed out, so
      // the prompt can say "not enough Command Points" instead of quietly not
      // existing. A reaction blocked by a limit does not apply at all.
      if (!affordability.ok) {
        if (affordability.kind !== "cost" || !offerableWhenUnaffordable(reaction)) continue;
      }

      const controller = reaction.mandatory
        ? "automatic"
        : reaction.automatic
        ? "automatic"
        : view.teamController(state.units[reactorId].teamId);

      const reactorRef = view.unitRefById(reactorId);
      offers.push({
        id: reaction.id + ":" + reactorId + ":" + event.__seq,
        reactionId: reaction.id,
        reactorId,
        reactorRef,
        linkId: linkId || null,
        name: reaction.name || reaction.id,
        description: reaction.description || "",
        // What accepting this does to the action that triggered it, in words,
        // before it is taken. Null for every reaction that only responds.
        intervention: interventionPreview(reaction, event, reactorRef),
        trigger: event.type,
        cost: reaction.cost || {},
        mandatory: !!reaction.mandatory,
        optional: !reaction.mandatory && !reaction.automatic,
        controller,
        priority: reaction.priority == null ? 50 : reaction.priority,
        speed: view.speed(reactorId),
        affordable: affordability.ok,
        blockedReason: affordability.ok ? null : affordability.reason
      });
    }
  }

  // Deterministic ordering: mandatory first (they cannot be declined and so
  // must not be starved of a shared pool by an optional one), then authored
  // priority, then the faster reactor, then creation order, then id.
  offers.sort(
    (a, b) =>
      Number(b.mandatory) - Number(a.mandatory) ||
      b.priority - a.priority ||
      b.speed - a.speed ||
      (state.units[a.reactorId].creationOrder - state.units[b.reactorId].creationOrder) ||
      a.id.localeCompare(b.id)
  );
  return offers;
}

/* ---------------------------------------------------------------
 * EXECUTION
 * -------------------------------------------------------------*/

function buildEffectContext(state, deps, view, reaction, reactorId, event) {
  const pickUnitId = (which) =>
    which === "source" ? event.sourceUnitId || null : event.unitId || null;

  return {
    state,
    engine: deps.engine,
    reactorId,
    event,
    unitRef: (id) => view.unitRefById(id),
    unitIsAlive: (id) => view.unitIsAlive(id),
    unitIsActionable: (id) => view.unitIsActionable(id),
    unitMovement: (id) => view.movement(id),
    reactorMovement: () => view.movement(reactorId),
    isHostile: (a, b) => view.relationship(a, b) === "hostile",
    eventUnitId: pickUnitId,
    eventTile: (which) => {
      if (which === "subject" && event.tile) return event.tile;
      const unitId = pickUnitId(which);
      const unit = unitId ? state.units[unitId] : null;
      // A destroyed unit still reports its last tile through the event, which
      // is exactly the opening an advance wants.
      if (!unit) return event.tile || null;
      return unit.alive ? { x: unit.x, y: unit.y } : event.tile || { x: unit.x, y: unit.y };
    },
    gainResource: (resourceId, unitId, amount) => {
      const raw = deps.index.resourceById[resourceId];
      if (!raw) return 0;
      const definition = normalizeResourceDefinition({ id: resourceId, ...raw });
      const owner =
        definition.scope === "faction"
          ? { teamId: view.unitTeam(unitId || reactorId) }
          : { unitId: unitId || reactorId };
      return gainResource(state, definition, owner, amount);
    }
  };
}

/** Re-checks legality at the moment of execution. Between the offer and here,
 *  an earlier reaction in the same chain may have killed the actor, flipped a
 *  faction or removed the target. */
function stillLegal(state, deps, view, reaction, reactorId, event) {
  if (!view.unitIsActionable(reactorId)) return "the reactor is no longer able to act";
  const ctx = buildConditionContext(state, deps, view, reaction, reactorId, event);
  if (!evaluateReactionCondition(reaction.conditions, ctx)) return "conditions no longer hold";
  const linkId = deps.index.linkByReaction[reaction.id];
  if (linkId && !isLinkActive(state.reactions.links, linkId)) return "the link is no longer active";
  return null;
}

function executeOffer(state, deps, offer, event) {
  const reactions = state.reactions;
  const reaction = deps.index.reactionById[offer.reactionId];
  const view = buildView(state, deps);

  const illegal = stillLegal(state, deps, view, reaction, offer.reactorId, event);
  if (illegal) {
    record(state, deps, {
      reactionId: offer.reactionId,
      reactorRef: offer.reactorRef,
      trigger: event.type,
      ok: false,
      reason: illegal
    });
    return { ok: false, reason: illegal };
  }

  const costs = costContext(state, deps, offer.reactorId, event);
  const affordability = canAfford(state, reactions.economy, reaction, costs);
  if (!affordability.ok) {
    record(state, deps, {
      reactionId: offer.reactionId,
      reactorRef: offer.reactorRef,
      trigger: event.type,
      ok: false,
      reason: affordability.reason
    });
    return { ok: false, reason: affordability.reason };
  }

  const paid = payCost(state, reactions.economy, reaction, costs);
  if (!paid) return { ok: false, reason: "could not pay the cost" };

  const ctx = buildEffectContext(state, deps, view, reaction, offer.reactorId, event);
  const definition = reactionEffectById(reaction.effect.type);
  if (!definition) {
    refundCost(state, paid);
    return { ok: false, reason: 'unknown reaction effect "' + reaction.effect.type + '"' };
  }

  let result;
  try {
    const run = () => definition.run(reaction.effect, ctx) || { ok: true };
    result = deps.engine.withReactionCause
      ? deps.engine.withReactionCause(state, reaction.id, run)
      : run();
  } catch (error) {
    refundCost(state, paid);
    state.errors.push("Reaction " + reaction.id + " threw: " + error.message);
    return { ok: false, reason: "effect failed" };
  }

  if (!result.ok) {
    // Nothing happened, so nothing is owed. This is the graceful path for
    // "the tile could not legally be entered" and its relatives.
    refundCost(state, paid);
    record(state, deps, {
      reactionId: offer.reactionId,
      reactorRef: offer.reactorRef,
      trigger: event.type,
      ok: false,
      reason: result.reason || "no effect"
    });
    return result;
  }

  reactions.executedThisEvent += 1;
  reactions.executedThisBattle += 1;
  record(state, deps, {
    reactionId: offer.reactionId,
    reactorRef: offer.reactorRef,
    trigger: event.type,
    ok: true,
    detail: result.detail || "",
    cost: reaction.cost || {}
  });

  deps.engine.logLine(
    state,
    "reaction",
    (offer.reactorRef || offer.reactorId) + " reacts: " + (reaction.name || reaction.id) +
      (result.detail ? " — " + result.detail : ""),
    { reactionId: reaction.id, unitId: offer.reactorId, trigger: event.type, linkId: offer.linkId }
  );

  // Effects queue events; drain them now so the cascade happens inside this
  // reaction's depth budget rather than leaking into the outer loop.
  deps.engine.processEvents(state);
  refreshLinks(state, deps);
  return result;
}

function record(state, deps, entry) {
  const log = state.reactions.log;
  log.push({ ...entry, at: state.activationCount });
  if (log.length > 40) log.shift();
}

/* ---------------------------------------------------------------
 * WINDOWS
 * -------------------------------------------------------------*/

/**
 * Runs one stage of one simulation event.
 *
 * @returns { suspended } — true when an optional player choice is pending and
 *          the caller must stop draining the queue.
 */
export function runReactionStage(state, deps, simEvent, stage) {
  const reactions = state.reactions;
  if (!reactions || !reactions.enabled) return { suspended: false };
  if (!REACTIVE_SIMULATION_EVENTS.has(simEvent.type)) return { suspended: false };
  if (reactions.window) return { suspended: true };

  if (reactions.depth >= REACTION_LIMITS.maxDepth) {
    noteGuard(state, "reaction depth limit (" + REACTION_LIMITS.maxDepth + ") reached; cascade stopped");
    return { suspended: false };
  }
  if (reactions.executedThisEvent >= REACTION_LIMITS.maxPerEvent) {
    noteGuard(state, "too many reactions for one event; cascade stopped");
    return { suspended: false };
  }
  if (reactions.executedThisBattle >= REACTION_LIMITS.maxPerBattle) return { suspended: false };

  const view = buildView(state, deps);
  const derived = deriveReactionEvents(simEvent, stage, {
    unitRefById: view.unitRefById,
    unitTeam: view.unitTeam,
    hpPercent: view.hpPercent,
    statusTags: view.statusTags
  });
  if (!derived.length) return { suspended: false };

  // Only events with a registered trigger are worth a window at all.
  const relevant = derived.filter((event) => deps.index.triggers.has(event.type));
  if (!relevant.length) return { suspended: false };

  for (const event of relevant) {
    event.__seq = simEvent.__seq + ":" + stage + ":" + event.type;
  }

  reactions.depth += 1;
  try {
    return drainReactionEvents(state, deps, relevant, stage);
  } finally {
    reactions.depth -= 1;
  }
}

function drainReactionEvents(state, deps, queue, stage) {
  const reactions = state.reactions;

  while (queue.length) {
    const event = queue.shift();
    const offers = discoverReactions(state, deps, event);
    if (!offers.length) continue;

    const resolution = resolveOffers(state, deps, offers, event);
    if (resolution.suspended) {
      // Park the rest of the queue on the window so a resume picks up exactly
      // where this left off — including after a save/load.
      reactions.window = {
        ...resolution.window,
        stage,
        remaining: queue.map((entry) => ({ ...entry }))
      };
      return { suspended: true };
    }
  }
  return { suspended: false };
}

/**
 * Decides what happens with a set of competing offers for one event.
 *
 * Mandatory and automatic offers execute in order. The first optional offer
 * whose controller is a human suspends into a window — unless the runtime is
 * in auto-resolve mode, in which case the deterministic policy applies.
 */
function resolveOffers(state, deps, offers, event) {
  const reactions = state.reactions;

  for (let index = 0; index < offers.length; index += 1) {
    const offer = offers[index];

    // An unaffordable offer exists only to be shown to a human. Nothing
    // resolves it automatically, and accepting one is refused below.
    if (offer.affordable === false && offer.controller !== "human") continue;

    if (offer.mandatory || offer.controller === "automatic") {
      executeOffer(state, deps, offer, event);
      continue;
    }

    if (offer.controller === "ai") {
      const choice = deps.chooseAiReaction
        ? deps.chooseAiReaction(state, offer, event)
        : defaultAiChoice(state, offer);
      if (choice) executeOffer(state, deps, offer, event);
      continue;
    }

    // Human-controlled and optional.
    if (reactions.autoResolve) {
      if (reactions.autoPolicy === "takeFirst") executeOffer(state, deps, offer, event);
      continue;
    }

    const pending = offers.slice(index).filter((entry) => entry.controller === "human" && entry.optional);
    // Nothing but affordable offers is worth suspending for: a window showing
    // only greyed-out entries would stop the battle to say "no".
    if (!pending.some((entry) => entry.affordable !== false)) continue;
    reactions.windowSeq += 1;
    return {
      suspended: true,
      window: {
        id: "rw" + reactions.windowSeq,
        event: { ...event },
        offers: pending,
        // Offers that come after the human's in the ordering still get their
        // turn once the choice resolves.
        deferred: offers.slice(index).filter((entry) => !(entry.controller === "human" && entry.optional))
      }
    };
  }

  return { suspended: false };
}

/** Deterministic default: take it if it is affordable. Enough to exercise
 *  legality and ordering; a real AI scorer replaces this later. */
function defaultAiChoice(state, offer) {
  return offer.priority >= 0;
}

/**
 * Resolves a suspended window. `offerId` null means "decline".
 *
 * @returns { ok, suspended } — suspended is true if another human choice
 *          immediately followed this one.
 */
export function resolveReactionWindow(state, deps, offerId) {
  const reactions = state.reactions;
  const window = reactions && reactions.window;
  if (!window) return { ok: false, suspended: false };

  reactions.window = null;
  const event = window.event;

  if (offerId) {
    const offer = window.offers.find((entry) => entry.id === offerId);
    if (offer && offer.affordable === false) {
      record(state, deps, {
        reactionId: offer.reactionId,
        reactorRef: offer.reactorRef,
        trigger: event.type,
        ok: false,
        reason: offer.blockedReason || "cannot be paid for"
      });
    } else if (offer) executeOffer(state, deps, offer, event);
    else state.errors.push("Unknown reaction offer: " + offerId);
  } else {
    record(state, deps, {
      reactionId: window.offers.length ? window.offers[0].reactionId : "none",
      reactorRef: window.offers.length ? window.offers[0].reactorRef : null,
      trigger: event.type,
      ok: false,
      reason: "declined"
    });
  }

  // Anything that was ordered after the human's choice still gets to resolve.
  for (const offer of window.deferred || []) {
    if (offer.mandatory || offer.controller === "automatic") executeOffer(state, deps, offer, event);
    else if (offer.controller === "ai") {
      const choice = deps.chooseAiReaction ? deps.chooseAiReaction(state, offer, event) : defaultAiChoice(state, offer);
      if (choice) executeOffer(state, deps, offer, event);
    }
  }

  const remaining = (window.remaining || []).map((entry) => ({ ...entry }));
  if (remaining.length) {
    const result = drainReactionEvents(state, deps, remaining, window.stage);
    return { ok: true, suspended: result.suspended };
  }
  return { ok: true, suspended: false };
}

/** Headless driver: resolves every pending window with the deterministic
 *  policy so a battle runs to completion without a renderer. */
export function autoResolveReactionWindows(state, deps, maxIterations) {
  const cap = maxIterations || 64;
  let iterations = 0;
  while (state.reactions && state.reactions.window) {
    iterations += 1;
    if (iterations > cap) {
      noteGuard(state, "auto-resolve exceeded its iteration cap");
      state.reactions.window = null;
      break;
    }
    const window = state.reactions.window;
    const takeable = window.offers.filter((offer) => offer.affordable !== false);
    const offerId =
      state.reactions.autoPolicy === "decline" || !takeable.length ? null : takeable[0].id;
    resolveReactionWindow(state, deps, offerId);
  }
}

function noteGuard(state, message) {
  if (!state.reactions.guards) state.reactions.guards = [];
  if (!state.reactions.guards.includes(message)) state.reactions.guards.push(message);
}

/* ---------------------------------------------------------------
 * HOOKS THE ENGINE CALLS
 * -------------------------------------------------------------*/

/** Called when a unit begins its activation: refresh capacity and pools, and
 *  reset the per-event counter. */
export function onUnitActivated(state, deps, unitId) {
  const reactions = state.reactions;
  if (!reactions) return;
  reactions.executedThisEvent = 0;
  regenerateOnActivation(
    state,
    deps.index.resourceDefinitions,
    unitId,
    resourceOwnership(reactions.links, deps.content.links, deps.index.resourceDefinitions)
  );
}

/** Called at the start of each simulation event, so the per-event budget is
 *  scoped to the triggering event rather than to the whole activation. */
export function beginSimulationEvent(state) {
  if (state.reactions) state.reactions.executedThisEvent = 0;
}

/* ---------------------------------------------------------------
 * PRESENTATION MODEL
 * -------------------------------------------------------------*/

export function describeReactions(state, deps) {
  const reactions = state.reactions;
  if (!reactions) return null;
  const resourceById = (id) => deps.index.resourceById[id] || null;
  const definitions = deps.index.resourceDefinitions;

  const links = describeLinks(reactions.links, deps.content.links, (linkId) =>
    definitions
      .filter((definition) => definition.linkId === linkId)
      .flatMap((definition) =>
        describeResources(state, [definition], { teamId: playerTeamId(state) }).faction
      )
  );
  const participantIds = [...new Set(links.flatMap((link) => link.participantUnitIds))];

  return {
    enabled: reactions.enabled,
    links,
    resources: describeResources(state, definitions, {
      teamId: playerTeamId(state),
      unitIds: participantIds
    }),
    window: reactions.window
      ? {
          id: reactions.window.id,
          trigger: reactions.window.event.type,
          triggerText: describeTrigger(state, reactions.window.event),
          cause: reactions.window.event.cause || null,
          offers: reactions.window.offers.map((offer) => ({
            id: offer.id,
            name: offer.name,
            description: offer.description,
            reactorRef: offer.reactorRef,
            reactorUnitId: offer.reactorId,
            intervention: offer.intervention || null,
            costText: describeCost(offer.cost, resourceById),
            affordable: offer.affordable !== false,
            blockedReason: offer.blockedReason || null,
            linkId: offer.linkId
          }))
        }
      : null,
    recent: reactions.log.slice(-6).reverse(),
    guards: reactions.guards || []
  };
}

/** Whose resource balances the HUD shows. The first human-controlled team,
 *  falling back to the first team — presentation only. */
function playerTeamId(state) {
  const human = (state.teams || []).find((team) => team.controller === "human");
  return human ? human.id : (state.teams && state.teams[0] ? state.teams[0].id : null);
}

function describeTrigger(state, event) {
  const subject = event.unitRef || "something";
  switch (event.type) {
    case "actionDeclared":
      // Present tense and unfinished on purpose. The whole point of this
      // window is that the thing has not happened yet.
      return subject + " is about to use " + (event.actionName || event.abilityId || "something");
    case "actionPrevented":
      return subject + " was stopped";
    case "targetMarked":
      return (event.sourceRef || "an ally") + " marked " + subject;
    case "unitDestroyed":
      return subject + " was destroyed";
    case "repairCompleted":
      return (event.sourceRef || "an ally") + " repaired " + subject;
    case "unitDamaged":
      return subject + " took damage";
    default:
      return event.type;
  }
}

export { isLinkActive, describeLinks };
