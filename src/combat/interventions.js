/* =========================================================================
 * PRE-RESOLUTION INTERVENTIONS
 *
 * Reactions could already happen *around* an action. They could not change
 * one. A guard could shield before the damage landed and a pursuer could
 * advance after the kill, but nobody could say "no" — and "no" is the entire
 * vocabulary of a defensive specialist.
 *
 * The gap was never a missing effect. It was that an action had no moment
 * between being chosen and being true. This module supplies that moment as a
 * plain record — a *declaration* — and a closed list of four things anyone is
 * allowed to do to it:
 *
 *   continue   it resolves as declared. The default, and what happens when
 *              nobody intervenes or every intervention is refused.
 *   cancel     it does not resolve at all. The cost is still spent.
 *   redirect   it resolves against a different target.
 *   replace    it does not resolve; something else already did instead.
 *
 * Four, not twenty. Every defensive fantasy this game has — a taunt, a body
 * block, a parry, a counter-charge, a suppression that makes someone think
 * better of it — is one of these four with different content around it. A
 * fifth kind should have to justify why it is not one of the four.
 *
 * WHAT THIS MODULE IS NOT
 *
 * It does not mutate commands. A command is already validated and already
 * executed by the time anything here runs; rewriting one after the fact would
 * mean every validator had to be re-runnable against a half-applied world.
 * Instead the *declaration* carries a verdict, and the engine decides what to
 * emit. The action is never edited — it is emitted, or not, or emitted
 * differently.
 *
 * It also knows nothing about abilities, units, reactions or the simulation.
 * It is a bookkeeper with strong opinions about ordering.
 * =======================================================================*/

/** The closed list. Anything not on it is not an intervention. */
export const INTERVENTION_KINDS = ["continue", "cancel", "redirect", "replace"];

/** Kinds that stop the declared action from resolving as written. */
const INTERRUPTING_KINDS = new Set(["cancel", "redirect", "replace"]);

export const INTERVENTION_LIMITS = {
  /**
   * How many interventions may commit against one declaration.
   *
   * One. Not because two could not be meaningful, but because deciding which
   * of two wins would need a precedence table, and a precedence table would
   * silently override the reaction ordering the author already controls
   * through priority, speed and creation order. Keeping the rule in one place
   * means adding a kind later cannot change the outcome of content that never
   * mentions it.
   */
  perDeclaration: 1,
  /**
   * How many interventions may commit inside one causal chain.
   *
   * A duelist intercepts; the enemy duelist intercepts the intercept. That is
   * a good fight. Six levels of it is two AI profiles arguing, and the player
   * is watching a cutscene they cannot influence.
   */
  perChain: 3,
  /** Declarations retained for the debug view. Bounded: a full history of a
   *  long battle is a memory leak wearing a diagnostics costume. */
  retained: 24
};

/** Why a proposal was refused. Stable ids, because the UI and the log both
 *  render them and tests assert on them. */
export const REFUSAL_REASONS = {
  unknownDeclaration: "that action is no longer pending",
  alreadyResolved: "that action has already resolved",
  alreadyIntervened: "something has already intervened in that action",
  chainLimit: "too many interventions in one chain",
  unknownKind: "not an intervention",
  notInterrupting: "continue is the default, not an intervention",
  missingTarget: "a redirect needs a target",
  sameTarget: "the action already resolves against that target",
  notRedirectable: "that action cannot be redirected"
};

/* ---------------------------------------------------------------
 * STATE
 * -------------------------------------------------------------*/

export function createInterventionState() {
  return {
    /** Declaration ids, oldest first. */
    order: [],
    byId: {},
    /** Travels in the save: reusing an id after a reload would make two
     *  devices indistinguishable in a causal trace. */
    nextId: 1,
    /** committed interventions per causal chain, bounded and evicted oldest
     *  first so a long battle does not accumulate one entry per command. */
    chainTally: {},
    chainOrder: []
  };
}

const CHAIN_TALLY_LIMIT = 32;

/**
 * A declaration: an action that has been chosen and paid for, but has not
 * happened yet.
 *
 * `redirectable` is authored rather than inferred. A single-target shot can be
 * pointed at somebody else; a self-buff and a five-tile blast cannot, and the
 * honest answer for those is that a defender must cancel or replace instead of
 * dragging an area effect across the map.
 */
export function openDeclaration(collection, declaration) {
  const id = "d" + collection.nextId;
  collection.nextId += 1;

  const record = {
    id,
    kind: declaration.kind || "ability",
    actorUnitId: declaration.actorUnitId || null,
    actorTeamId: declaration.actorTeamId || null,
    abilityId: declaration.abilityId || null,
    targetUnitIds: (declaration.targetUnitIds || []).slice(),
    tile: declaration.tile ? { x: declaration.tile.x, y: declaration.tile.y } : null,
    path: declaration.path ? declaration.path.map((step) => ({ x: step.x, y: step.y })) : null,
    redirectable: declaration.redirectable !== false,
    chainId: declaration.chainId || null,
    openedAt: declaration.openedAt == null ? 0 : declaration.openedAt,
    /** The current answer. Never null: an unintervened action continues. */
    verdict: { kind: "continue", byUnitId: null, byReactionId: null, detail: "" },
    /** Everything that was proposed, accepted or not. The debug trail — a
     *  refused intervention is exactly as interesting as an accepted one when
     *  somebody asks why their duelist did nothing. */
    proposals: [],
    resolved: false
  };

  collection.order.push(id);
  collection.byId[id] = record;
  prune(collection);
  return record;
}

/** Drops the oldest *resolved* declarations. An open one is never pruned:
 *  losing it would strand the action waiting on its verdict. */
function prune(collection) {
  while (collection.order.length > INTERVENTION_LIMITS.retained) {
    const index = collection.order.findIndex((id) => collection.byId[id].resolved);
    if (index < 0) return;
    const [dropped] = collection.order.splice(index, 1);
    delete collection.byId[dropped];
  }
}

export function findDeclaration(collection, id) {
  if (!collection || !id) return null;
  return collection.byId[id] || null;
}

/** The declaration currently awaiting a verdict, if any. There is at most one:
 *  an action resolves before the next one is declared. */
export function openDeclarationOf(collection) {
  if (!collection) return null;
  for (let i = collection.order.length - 1; i >= 0; i -= 1) {
    const record = collection.byId[collection.order[i]];
    if (record && !record.resolved) return record;
  }
  return null;
}

/* ---------------------------------------------------------------
 * PROPOSING
 * -------------------------------------------------------------*/

function tallyFor(collection, chainId) {
  if (!chainId) return 0;
  return collection.chainTally[chainId] || 0;
}

function countChain(collection, chainId) {
  if (!chainId) return;
  if (collection.chainTally[chainId] == null) {
    collection.chainTally[chainId] = 0;
    collection.chainOrder.push(chainId);
    while (collection.chainOrder.length > CHAIN_TALLY_LIMIT) {
      const evicted = collection.chainOrder.shift();
      delete collection.chainTally[evicted];
    }
  }
  collection.chainTally[chainId] += 1;
}

/**
 * Offers an intervention against a declaration.
 *
 * Proposals arrive in reaction-execution order, which is already deterministic
 * — mandatory first, then authored priority, then speed, then creation order.
 * The first one that survives these checks commits, and every later one is
 * refused and recorded. That is the whole ordering rule; there is no second
 * one hiding here.
 *
 * `validate` is the caller's hook for legality that this module cannot judge:
 * whether the new target is in range, whether the redirected shot still has
 * line of sight. It returns null to accept or a reason string to refuse, and
 * it runs *before* anything is committed, so a refused redirect leaves the
 * declaration exactly as it was.
 *
 * @returns { ok, reason, record }
 */
export function proposeIntervention(collection, declarationId, proposal, validate) {
  const record = findDeclaration(collection, declarationId);
  if (!record) return refuse(null, REFUSAL_REASONS.unknownDeclaration);
  if (record.resolved) return refuse(record, REFUSAL_REASONS.alreadyResolved, proposal);

  const kind = proposal && proposal.kind;
  if (!INTERVENTION_KINDS.includes(kind)) {
    return refuse(record, REFUSAL_REASONS.unknownKind, proposal);
  }
  if (!INTERRUPTING_KINDS.has(kind)) {
    return refuse(record, REFUSAL_REASONS.notInterrupting, proposal);
  }
  if (record.verdict.kind !== "continue") {
    return refuse(record, REFUSAL_REASONS.alreadyIntervened, proposal);
  }
  if (tallyFor(collection, record.chainId) >= INTERVENTION_LIMITS.perChain) {
    return refuse(record, REFUSAL_REASONS.chainLimit, proposal);
  }

  if (kind === "redirect") {
    if (!record.redirectable) return refuse(record, REFUSAL_REASONS.notRedirectable, proposal);
    if (!proposal.targetUnitId) return refuse(record, REFUSAL_REASONS.missingTarget, proposal);
    if (
      record.targetUnitIds.length === 1 &&
      record.targetUnitIds[0] === proposal.targetUnitId
    ) {
      return refuse(record, REFUSAL_REASONS.sameTarget, proposal);
    }
  }

  const objection = validate ? validate(record, proposal) : null;
  if (objection) return refuse(record, objection, proposal);

  record.verdict = {
    kind,
    byUnitId: proposal.byUnitId || null,
    byReactionId: proposal.byReactionId || null,
    targetUnitId: kind === "redirect" ? proposal.targetUnitId : null,
    tile: proposal.tile ? { x: proposal.tile.x, y: proposal.tile.y } : null,
    detail: proposal.detail || ""
  };
  record.proposals.push({ ...record.verdict, accepted: true });
  countChain(collection, record.chainId);
  return { ok: true, reason: null, record };
}

function refuse(record, reason, proposal) {
  if (record) {
    record.proposals.push({
      kind: (proposal && proposal.kind) || "unknown",
      byUnitId: (proposal && proposal.byUnitId) || null,
      byReactionId: (proposal && proposal.byReactionId) || null,
      accepted: false,
      reason
    });
  }
  return { ok: false, reason, record };
}

/**
 * Closes a declaration and hands back the verdict to act on.
 *
 * Called exactly once per declaration, by the engine, at the moment it decides
 * what to emit. Calling it twice reports `continue` the second time rather
 * than throwing: a double resolve is a bug, but a bug that stops the battle is
 * worse than one that lets it finish.
 */
export function resolveDeclaration(collection, declarationId) {
  const record = findDeclaration(collection, declarationId);
  if (!record || record.resolved) {
    return { kind: "continue", byUnitId: null, byReactionId: null, detail: "" };
  }
  record.resolved = true;
  prune(collection);
  return record.verdict;
}

/* ---------------------------------------------------------------
 * PRESENTATION
 * -------------------------------------------------------------*/

/**
 * What an intervention would do, in words, before it is taken.
 *
 * This exists because a reaction prompt that says "Intercept — 1 Command
 * Point" and nothing else is asking the player to gamble. The consequence is
 * the whole decision.
 */
export function describeIntervention(kind, options) {
  const opts = options || {};
  const action = opts.actionName || "the action";
  const actor = opts.actorName || "the attacker";
  const target = opts.targetName || "you";
  switch (kind) {
    case "cancel":
      return action + " does not happen. " + actor + " still pays for it.";
    case "redirect":
      return action + " hits " + target + " instead.";
    case "replace":
      return actor + " deals with " + target + " first; " + action + " never resolves.";
    case "continue":
      return action + " resolves as declared.";
    default:
      return "";
  }
}

/** Past tense, for the combat log. */
export function describeVerdict(verdict, options) {
  if (!verdict || verdict.kind === "continue") return "";
  const opts = options || {};
  const action = opts.actionName || "the action";
  const by = opts.byName || "someone";
  switch (verdict.kind) {
    case "cancel":
      return by + " stops " + action;
    case "redirect":
      return by + " pulls " + action + " onto " + (opts.targetName || "a different target");
    case "replace":
      return by + " intervenes; " + action + " never resolves";
    default:
      return "";
  }
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 *
 * Plain data in, plain data out. A save taken while a declaration is open
 * resumes with the same declaration and the same verdict, and a save taken
 * before interventions existed loads with an empty collection rather than
 * being rejected.
 * -------------------------------------------------------------*/

export function serializeInterventions(collection) {
  if (!collection) return null;
  return {
    order: collection.order.slice(),
    byId: Object.fromEntries(
      collection.order.map((id) => [id, JSON.parse(JSON.stringify(collection.byId[id]))])
    ),
    nextId: collection.nextId,
    chainTally: { ...collection.chainTally },
    chainOrder: collection.chainOrder.slice()
  };
}

export function deserializeInterventions(raw) {
  const fresh = createInterventionState();
  if (!raw || !Array.isArray(raw.order)) return fresh;
  fresh.order = raw.order.filter((id) => raw.byId && raw.byId[id]);
  fresh.byId = Object.fromEntries(fresh.order.map((id) => [id, { ...raw.byId[id] }]));
  fresh.nextId = raw.nextId || fresh.order.length + 1;
  fresh.chainTally = { ...(raw.chainTally || {}) };
  fresh.chainOrder = (raw.chainOrder || []).filter((id) => fresh.chainTally[id] != null);
  return fresh;
}
