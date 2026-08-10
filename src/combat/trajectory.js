/* =========================================================================
 * TRAJECTORY
 *
 * A route across the grid, described well enough to charge for its turns and
 * to hit something halfway along it.
 *
 * The engine already had movement: a path, validated step by step, applied in
 * one event. What it could not express is a *route* — something with segments,
 * a heading that changes at known points, and permission to do something in
 * the middle without ending. Those three facts are what a charge, a pass, a
 * drive-by and a high-speed intercept all need, and none of them is worth a
 * subsystem of its own.
 *
 * So this module adds a description, not a movement system. It plans:
 *
 *   start ─segment─▶ redirect ─segment─▶ redirect ─segment─▶ endpoint
 *                       ▲                    ▲
 *                    a heading change, categorised and priceable
 *
 * and it plans it by asking the *engine's own* step validator about every
 * tile. There is deliberately no second pathfinder and no second legality
 * model: a plan that says a tile is reachable is making the engine's claim,
 * not its own. That is what lets the same function serve execution, the
 * preview the player confirms, and the tests.
 *
 * What it is not: physics. Tiles, integers, discrete headings. A trajectory
 * with one segment and no contacts is exactly an ordinary move.
 *
 * Pure data and pure functions. No engine imports, no React, no content ids.
 * =======================================================================*/

/* ---------------------------------------------------------------
 * HEADINGS
 * -------------------------------------------------------------*/

/** The eight grid headings, as unit vectors. Movement headings are not the
 *  same thing as a unit's facing: facing is four isometric directions chosen
 *  for how the art reads, and a route needs to know it turned even when the
 *  sprite would not change. */
export const HEADINGS = [
  { id: "n", dx: 0, dy: -1, angle: 0 },
  { id: "ne", dx: 1, dy: -1, angle: 45 },
  { id: "e", dx: 1, dy: 0, angle: 90 },
  { id: "se", dx: 1, dy: 1, angle: 135 },
  { id: "s", dx: 0, dy: 1, angle: 180 },
  { id: "sw", dx: -1, dy: 1, angle: 225 },
  { id: "w", dx: -1, dy: 0, angle: 270 },
  { id: "nw", dx: -1, dy: -1, angle: 315 }
];

const HEADING_BY_VECTOR = Object.fromEntries(HEADINGS.map((h) => [h.dx + "," + h.dy, h]));
export const HEADING_IDS = HEADINGS.map((entry) => entry.id);

export function headingById(id) {
  return HEADINGS.find((entry) => entry.id === id) || null;
}

/** The heading from one tile to an adjacent one, or null if they are not
 *  adjacent (or are the same tile). */
export function headingBetween(from, to) {
  if (!from || !to) return null;
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (!dx && !dy) return null;
  if (Math.abs(to.x - from.x) > 1 || Math.abs(to.y - from.y) > 1) return null;
  return HEADING_BY_VECTOR[dx + "," + dy] || null;
}

/* ---------------------------------------------------------------
 * REDIRECTS
 *
 * How sharply the route turned, as a category content can price. Angles are
 * kept alongside the category so a future movement model with finer turns is
 * a data change here rather than a new vocabulary everywhere else.
 * -------------------------------------------------------------*/

export const REDIRECT_CATEGORIES = [
  { id: "straight", maxAngle: 0, label: "Straight on" },
  { id: "slight", maxAngle: 45, label: "Slight turn" },
  { id: "quarter", maxAngle: 90, label: "Quarter turn" },
  { id: "sharp", maxAngle: 135, label: "Hard turn" },
  { id: "reverse", maxAngle: 180, label: "Reversal" }
];

export const REDIRECT_IDS = REDIRECT_CATEGORIES.map((entry) => entry.id);

/** Smallest angle between two headings, 0–180. */
export function redirectAngle(fromHeading, toHeading) {
  if (!fromHeading || !toHeading) return 0;
  const raw = Math.abs(toHeading.angle - fromHeading.angle) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export function redirectCategory(fromHeading, toHeading) {
  const angle = redirectAngle(fromHeading, toHeading);
  const found = REDIRECT_CATEGORIES.find((entry) => angle <= entry.maxAngle);
  return found ? found.id : "reverse";
}

/* ---------------------------------------------------------------
 * PLANNING
 * -------------------------------------------------------------*/

/**
 * Resolves an authored route into something the engine can execute, or explain
 * why it cannot.
 *
 * `segments` is what the player or the AI chose:
 *
 *   [{ heading: "e", distance: 4 },
 *    { heading: "n", distance: 3, contact: { targetRef: … } }]
 *
 * or, equivalently, explicit tile lists. Heading form is what a planning UI
 * produces; tile form is what a test or a replay hands back. Both resolve to
 * the same plan.
 *
 * `deps` is the engine adapter:
 *   canEnter(from, to)   → { ok, reason }   the engine's own step validator
 *   unitAt(tile)         → unitId | null
 *   maxSegments, maxDistance                bounds from configuration
 *
 * The plan is always returned, even when illegal — `legal` says whether it can
 * run and `stopIndex` says how far it got. A preview that could only render
 * legal routes would be unable to show the player *where* their route breaks,
 * which is the one thing they need to see.
 */
export function planTrajectory(origin, segments, deps, options) {
  const opts = options || {};
  const limits = {
    maxSegments: opts.maxSegments == null ? 4 : opts.maxSegments,
    maxDistance: opts.maxDistance == null ? 24 : opts.maxDistance,
    allowedRedirects: opts.allowedRedirects || null
  };

  const plan = {
    origin: { x: origin.x, y: origin.y },
    segments: [],
    tiles: [{ x: origin.x, y: origin.y }],
    redirects: [],
    totalDistance: 0,
    endpoint: { x: origin.x, y: origin.y },
    legal: true,
    stopIndex: null,
    reason: null,
    contacts: []
  };

  const requested = Array.isArray(segments) ? segments : [];
  if (!requested.length) {
    plan.legal = false;
    plan.reason = "a trajectory needs at least one segment";
    return plan;
  }
  if (requested.length > limits.maxSegments) {
    plan.legal = false;
    plan.reason =
      "this route has " + requested.length + " segments; the action allows " + limits.maxSegments;
    return plan;
  }

  let cursor = { x: origin.x, y: origin.y };
  let previousHeading = opts.initialHeading ? headingById(opts.initialHeading) : null;

  for (let index = 0; index < requested.length; index += 1) {
    const raw = requested[index];
    const resolved = resolveSegment(cursor, raw);
    if (resolved.error) {
      plan.legal = false;
      plan.stopIndex = index;
      plan.reason = resolved.error;
      return plan;
    }

    const heading = resolved.heading;
    const redirect = previousHeading
      ? {
          atIndex: index,
          tile: { x: cursor.x, y: cursor.y },
          from: previousHeading.id,
          to: heading.id,
          angle: redirectAngle(previousHeading, heading),
          category: redirectCategory(previousHeading, heading)
        }
      : null;

    if (redirect && redirect.category !== "straight") {
      if (limits.allowedRedirects && !limits.allowedRedirects.includes(redirect.category)) {
        plan.legal = false;
        plan.stopIndex = index;
        plan.reason = "this action cannot make a " + redirect.category + " turn";
        plan.redirects.push(redirect);
        return plan;
      }
      plan.redirects.push(redirect);
    } else if (redirect) {
      // A straight "redirect" is not a turn; recorded so the segment count and
      // the redirect list stay aligned, but never charged for.
      plan.redirects.push(redirect);
    }

    const segment = {
      index,
      heading: heading.id,
      from: { x: cursor.x, y: cursor.y },
      to: { x: cursor.x, y: cursor.y },
      tiles: [],
      distance: 0,
      requestedDistance: resolved.tiles.length,
      redirect: redirect && redirect.category !== "straight" ? redirect.category : null,
      contact: raw && raw.contact ? { ...raw.contact, segment: index } : null,
      blocked: false,
      blockReason: null,
      blockTile: null,
      blockedBy: null
    };

    for (const tile of resolved.tiles) {
      if (plan.totalDistance >= limits.maxDistance) {
        segment.blocked = true;
        segment.blockReason = "out of movement";
        segment.blockTile = { x: tile.x, y: tile.y };
        break;
      }
      const step = deps.canEnter(cursor, tile);
      if (!step.ok) {
        segment.blocked = true;
        segment.blockReason = step.reason || "the way is blocked";
        segment.blockTile = { x: tile.x, y: tile.y };
        segment.blockedBy = deps.unitAt ? deps.unitAt(tile) : null;
        break;
      }
      cursor = { x: tile.x, y: tile.y };
      segment.tiles.push({ x: tile.x, y: tile.y });
      segment.distance += 1;
      plan.tiles.push({ x: tile.x, y: tile.y });
      plan.totalDistance += 1;
    }

    segment.to = { x: cursor.x, y: cursor.y };
    plan.segments.push(segment);
    if (segment.contact) plan.contacts.push(segment.contact);
    previousHeading = heading;

    if (segment.blocked) {
      // A route that cannot be completed is not silently truncated. The caller
      // decides whether a partial run is acceptable; the plan says exactly
      // where and why it stopped.
      plan.legal = false;
      plan.stopIndex = index;
      plan.reason = segment.blockReason;
      break;
    }
  }

  plan.endpoint = { x: cursor.x, y: cursor.y };
  if (plan.legal && plan.totalDistance === 0) {
    plan.legal = false;
    plan.reason = "this route covers no ground";
  }
  return plan;
}

/** One segment's intended tiles, from either heading+distance or explicit tiles. */
function resolveSegment(from, raw) {
  if (!raw || typeof raw !== "object") return { error: "a segment must be an object" };

  if (Array.isArray(raw.tiles) && raw.tiles.length) {
    const tiles = raw.tiles.map((tile) => ({ x: tile.x, y: tile.y }));
    const heading = headingBetween(from, tiles[0]);
    if (!heading) return { error: "the first tile of a segment must be adjacent to its start" };
    // Every tile in a segment must continue the same heading — that is what
    // makes it a segment rather than a path.
    let cursor = from;
    for (const tile of tiles) {
      const step = headingBetween(cursor, tile);
      if (!step || step.id !== heading.id) {
        return { error: "a segment travels in one heading; use another segment to turn" };
      }
      cursor = tile;
    }
    return { heading, tiles };
  }

  const heading = headingById(raw.heading);
  if (!heading) return { error: 'unknown heading "' + raw.heading + '"' };
  const distance = Math.max(0, Math.floor(Number(raw.distance) || 0));
  if (!distance) return { error: "a segment needs a distance of at least 1" };

  const tiles = [];
  let cursor = from;
  for (let step = 0; step < distance; step += 1) {
    cursor = { x: cursor.x + heading.dx, y: cursor.y + heading.dy };
    tiles.push(cursor);
  }
  return { heading, tiles };
}

/* ---------------------------------------------------------------
 * RUNTIME CONTEXT
 *
 * What conditions and effects may read while a route is running. Kept as plain
 * serializable data on battle state, so a save taken mid-route resumes with
 * the same answers and a replay reproduces them.
 * -------------------------------------------------------------*/

export function createTrajectoryContext(plan, unitId, options) {
  return {
    unitId,
    abilityId: (options && options.abilityId) || null,
    origin: { ...plan.origin },
    endpoint: { ...plan.endpoint },
    plannedDistance: plan.totalDistance,
    plannedSegments: plan.segments.length,
    /** Filled in as the route runs. */
    distanceTravelled: 0,
    segmentIndex: 0,
    segmentDistance: 0,
    redirectCount: 0,
    heading: plan.segments.length ? plan.segments[0].heading : null,
    previousHeading: null,
    lastRedirect: null,
    interrupted: false,
    interruptReason: null,
    /** Where and on whom the route actually stopped, when it stopped early. */
    blockTile: null,
    blockedBy: null,
    completed: false,
    contacts: []
  };
}

/** Advances the context across one resolved segment. Pure bookkeeping. */
export function advanceContext(context, segment) {
  if (segment.redirect) {
    context.redirectCount += 1;
    context.lastRedirect = segment.redirect;
  }
  context.previousHeading = context.heading;
  context.heading = segment.heading;
  context.segmentIndex = segment.index;
  context.segmentDistance = segment.distance;
  context.distanceTravelled += segment.distance;
  return context;
}

/** The redirect categories a route uses, with how many of each. Content prices
 *  a route from this without the engine knowing what a price is. */
export function redirectTally(plan) {
  const tally = {};
  for (const redirect of plan.redirects || []) {
    if (redirect.category === "straight") continue;
    tally[redirect.category] = (tally[redirect.category] || 0) + 1;
  }
  return tally;
}

/**
 * What a route costs, given an authored price list.
 *
 * `costs` is `{ quarter: 1, sharp: 2, reverse: 3 }` — content's numbers, in
 * content's units. This module multiplies and adds; it does not know what is
 * being spent or whether the mover can afford it.
 */
export function redirectCost(plan, costs) {
  const tally = redirectTally(plan);
  let total = 0;
  const breakdown = [];
  for (const category of Object.keys(tally)) {
    const each = Number((costs || {})[category] || 0);
    const amount = each * tally[category];
    if (amount) breakdown.push({ category, count: tally[category], each, amount });
    total += amount;
  }
  return { total, breakdown };
}

/* ---------------------------------------------------------------
 * DISPLACEMENT
 *
 * Precise forced movement. The distinction from a shove is the whole point:
 * an author asks for *this many tiles*, not "as far as it goes", because the
 * exact tile is what opens a firing lane or completes a cluster.
 * -------------------------------------------------------------*/

/**
 * Plans a displacement, in tiles, along one heading.
 *
 * Returns the same shape whether or not it succeeds, including how far it
 * actually got and what stopped it, so a reaction can respond to the shove
 * that fell short as readily as to the one that landed.
 */
export function planDisplacement(origin, heading, distance, deps, options) {
  const opts = options || {};
  const vector = headingById(heading);
  const out = {
    origin: { x: origin.x, y: origin.y },
    heading: vector ? vector.id : null,
    requested: Math.max(0, Math.floor(Number(distance) || 0)),
    actual: 0,
    tiles: [],
    endpoint: { x: origin.x, y: origin.y },
    blocked: false,
    blockReason: null,
    blockTile: null,
    blockedBy: null,
    resisted: 0
  };
  if (!vector) {
    out.blocked = true;
    out.blockReason = 'unknown heading "' + heading + '"';
    return out;
  }

  // Resistance shortens the shove before the walk begins, so a braced target
  // moves less rather than being stopped by something invisible partway.
  const resistance = Math.max(0, Math.floor(Number(opts.resistance) || 0));
  out.resisted = Math.min(resistance, out.requested);
  const effective = Math.max(0, out.requested - resistance);

  let cursor = { x: origin.x, y: origin.y };
  for (let step = 0; step < effective; step += 1) {
    const next = { x: cursor.x + vector.dx, y: cursor.y + vector.dy };
    const check = deps.canEnter(cursor, next);
    if (!check.ok) {
      out.blocked = true;
      out.blockReason = check.reason || "the way is blocked";
      out.blockTile = next;
      out.blockedBy = deps.unitAt ? deps.unitAt(next) : null;
      break;
    }
    cursor = next;
    out.tiles.push({ x: next.x, y: next.y });
    out.actual += 1;
  }

  out.endpoint = cursor;
  return out;
}
