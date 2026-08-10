/* =========================================================================
 * EVENT CAUSALITY
 *
 * Why something happened, tracked well enough to reason about safely.
 *
 * A tactical chain like
 *
 *   impact → forced movement → the target loses its cover
 *          → a prepared shooter reacts → the target dies
 *          → an ally reacts and advances
 *
 * is four causal steps deep, and every one of them is an ordinary event. Once
 * reactions can produce events that produce reactions, three questions need
 * answers the queue alone cannot give:
 *
 *   what caused this?        the parent event
 *   what started all this?   the root, shared by everything in one chain
 *   how deep are we?         the recursion budget
 *
 * This is deliberately not an event-sourcing platform. It is four fields and
 * an ambient stack: enough to attribute a kill, bound a cascade, and let a
 * "once per chain" limit mean something. Everything is plain serializable data
 * so a save taken mid-chain resumes with its causality intact.
 * =======================================================================*/

/** How deep a causal chain may go before the runtime calls it a bug. Reaction
 *  depth is bounded separately; this bounds the events themselves. */
export const MAX_CHAIN_DEPTH = 16;

export function createCausalityState() {
  return {
    chainSeq: 0,
    /** The cause new events inherit, or null at the top of the stack. */
    current: null
  };
}

/**
 * A fresh root cause. Called when something starts a new chain: a command, an
 * activation, a mission action.
 */
export function beginChain(causality, origin) {
  causality.chainSeq += 1;
  return {
    chainId: "c" + causality.chainSeq,
    rootSeq: null,
    parentSeq: null,
    depth: 0,
    origin: origin || "command",
    // Forced and reaction are inherited by descendants unless a step says
    // otherwise, because "this happened because something forced it" stays
    // true for everything downstream of the shove.
    forced: false,
    viaReaction: false,
    viaReactionId: null
  };
}

/**
 * The cause a child event inherits from the event currently being handled.
 *
 * `overrides` is how a step declares something new about itself — a forced
 * move sets `forced: true`, a reaction's effects set `viaReaction: true` —
 * and those flags then propagate on their own.
 */
export function childCause(parentCause, parentSeq, overrides) {
  const base = parentCause || {
    chainId: "c0",
    rootSeq: null,
    parentSeq: null,
    depth: 0,
    origin: "unattributed",
    forced: false,
    viaReaction: false,
    viaReactionId: null
  };
  return {
    chainId: base.chainId,
    rootSeq: base.rootSeq || parentSeq || null,
    parentSeq: parentSeq || base.parentSeq || null,
    depth: base.depth + 1,
    origin: base.origin,
    forced: base.forced,
    viaReaction: base.viaReaction,
    viaReactionId: base.viaReactionId,
    ...overrides
  };
}

/**
 * Stamps an event with its cause, if it does not carry one already.
 *
 * Events queued by an effect inherit the cause of whatever is running. An
 * event that arrives with its own `cause` keeps it, which is how a resumed
 * save reattaches to the chain it was suspended in.
 */
export function stampCause(causality, event) {
  if (!event.cause) {
    event.cause = causality.current
      ? childCause(causality.current, causality.current.__eventSeq || null)
      : beginChain(causality, "unattributed");
  }
  return event;
}

/**
 * Runs `fn` with `event`'s cause as the ambient parent.
 *
 * Restores the previous cause afterwards even if `fn` throws, so one bad
 * handler cannot corrupt the attribution of everything after it.
 */
export function withCause(causality, event, fn) {
  const previous = causality.current;
  const cause = event.cause ? { ...event.cause, __eventSeq: event.__seq } : null;
  causality.current = cause;
  try {
    return fn();
  } finally {
    causality.current = previous;
  }
}

/** True when the chain has gone deeper than anything legitimate would. */
export function chainExhausted(cause) {
  return !!cause && cause.depth >= MAX_CHAIN_DEPTH;
}

/** A one-line explanation, for the combat log and the debug view. */
export function describeCause(cause) {
  if (!cause) return "unattributed";
  const parts = [cause.chainId + " depth " + cause.depth];
  if (cause.origin && cause.origin !== "command") parts.push(cause.origin);
  if (cause.forced) parts.push("forced");
  if (cause.viaReaction) parts.push("via " + (cause.viaReactionId || "a reaction"));
  return parts.join(" · ");
}

/**
 * Walks a chain back to its root from a flat list of records.
 *
 * Used by the debug view to answer "why did that fire?" without the runtime
 * having to keep a tree in memory during the battle.
 */
export function traceChain(records, seq) {
  const bySeq = {};
  for (const record of records || []) bySeq[record.seq] = record;
  const out = [];
  let cursor = bySeq[seq];
  let guard = 0;
  while (cursor && guard < MAX_CHAIN_DEPTH + 4) {
    out.unshift(cursor);
    const parentSeq = cursor.cause ? cursor.cause.parentSeq : null;
    cursor = parentSeq ? bySeq[parentSeq] : null;
    guard += 1;
  }
  return out;
}
