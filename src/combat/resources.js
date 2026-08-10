/* =========================================================================
 * COMBAT RESOURCES
 *
 * One mechanism for every pool of points a battle tracks.
 *
 * Before this module the project had two: per-unit `unit.resources`, authored
 * on a chassis and spent by ability costs, and a separate shared-pool system
 * that only reactions could reach. They did the same job with different code,
 * different serialization and different vocabulary — so a designer wanting a
 * squad resource had to pick a side, and half the engine could not see it.
 *
 * There is now one definition shape, two scopes:
 *
 *   unit      every unit gets its own balance. Burst, heat, ammunition.
 *   faction   one balance shared by a whole side. Command Points.
 *
 * Availability is separate from balance. A resource can be present but not
 * usable — a shared pool whose combat link has lapsed still remembers its
 * points, it simply cannot be spent from. That distinction is what stops a
 * link flickering off and on from handing out free tempo.
 *
 * Pure data and pure functions. No engine imports, no React, no content ids.
 * =======================================================================*/

export const RESOURCE_SCOPES = ["unit", "faction"];

/** How a resource comes back on its own. */
export const REGEN_TRIGGERS = [
  // Never regenerates; only an effect restores it.
  "manual",
  // Regains on every activation by any unit that owns the resource. For a
  // faction resource that is any unit of the faction; for a link-gated one it
  // is any participant. Suits a tempo economy on a continuous timeline, where
  // there are no rounds to refresh on.
  "ownerActivation",
  // Regains when the owning unit itself activates. Unit scope only.
  "selfActivation"
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/* ---------------------------------------------------------------
 * DEFINITIONS
 * -------------------------------------------------------------*/

/** Fills in the defaults so the rest of the module never checks for absent
 *  fields. Unknown keys survive, so a future field round-trips. */
export function normalizeResourceDefinition(raw) {
  const entry = { ...raw };
  entry.scope = RESOURCE_SCOPES.includes(entry.scope) ? entry.scope : "unit";
  entry.max = Number.isFinite(Number(entry.max)) ? Number(entry.max) : 0;
  entry.startsAt = entry.startsAt == null ? entry.max : Number(entry.startsAt);
  entry.regen = entry.regen && typeof entry.regen === "object" ? { ...entry.regen } : null;
  if (entry.regen) {
    entry.regen.on = REGEN_TRIGGERS.includes(entry.regen.on) ? entry.regen.on : "manual";
    entry.regen.amount = entry.regen.amount == null ? 1 : Number(entry.regen.amount);
  }
  // `persist: false` means the resource resets between battles. Nothing in the
  // project carries a resource across missions yet; the flag exists so the
  // first thing that does is a data edit.
  entry.persist = entry.persist === true;
  // Whether every unit carries this resource, or only chassis that declare it.
  // A reaction-capacity pool is universal; a character's Burst is not, and
  // auto-creating one on a unit that never earned it would hand out points.
  entry.everyUnit = entry.everyUnit === true;
  // An optional combat link gate. The resource exists either way; while the
  // link is inactive it is unavailable.
  entry.linkId = entry.linkId || null;
  return entry;
}

/* ---------------------------------------------------------------
 * RUNTIME STATE
 * -------------------------------------------------------------*/

/**
 * Battle resource state.
 *
 * Unit-scoped balances stay on the unit (`unit.resources`), where they already
 * lived and where they already serialize; duplicating them here would be the
 * exact mistake this module exists to undo. Only faction balances are new.
 */
export function createResourceState(definitions, teamIds) {
  const faction = {};
  for (const teamId of teamIds || []) faction[teamId] = {};
  for (const raw of definitions || []) {
    const definition = normalizeResourceDefinition(raw);
    if (definition.scope !== "faction") continue;
    for (const teamId of teamIds || []) {
      faction[teamId][definition.id] = {
        current: clamp(definition.startsAt, 0, definition.max),
        max: definition.max,
        // Ungated resources are usable from the start. A link-gated one waits
        // for the link evaluation that runs at battle creation.
        available: !definition.linkId
      };
    }
  }
  return { faction };
}

/**
 * A unit's balance record.
 *
 * Created on demand only for universal resources. For everything else the
 * chassis has to have declared it — otherwise asking whether a unit can pay a
 * cost would be what gives it the means to.
 */
function unitEntry(unit, definition) {
  if (!unit.resources) unit.resources = {};
  if (!unit.resources[definition.id]) {
    if (!definition.everyUnit) return null;
    unit.resources[definition.id] = {
      current: clamp(definition.startsAt, 0, definition.max),
      max: definition.max
    };
  }
  return unit.resources[definition.id];
}

/**
 * The balance record a (resource, owner) pair addresses, or null.
 *
 * `owner` is a unit id for unit scope and a team id for faction scope. A
 * caller that has only a unit id can pass `{ unitId, teamId }` and let this
 * pick the right one.
 */
export function resourceEntry(state, definition, owner) {
  if (!definition) return null;
  if (definition.scope === "faction") {
    const teamId = owner && owner.teamId !== undefined ? owner.teamId : owner;
    const bucket = state.resources && state.resources.faction[teamId];
    return bucket ? bucket[definition.id] || null : null;
  }
  const unitId = owner && owner.unitId !== undefined ? owner.unitId : owner;
  const unit = state.units[unitId];
  return unit ? unitEntry(unit, definition) : null;
}

/** Every unit-scoped resource a unit actually carries. */
export function unitResourceIds(state, unitId) {
  const unit = state.units[unitId];
  return unit && unit.resources ? Object.keys(unit.resources).sort() : [];
}

/* ---------------------------------------------------------------
 * READ / WRITE
 * -------------------------------------------------------------*/

export function resourceBalance(state, definition, owner) {
  const entry = resourceEntry(state, definition, owner);
  return entry ? entry.current : 0;
}

export function resourceIsAvailable(state, definition, owner) {
  const entry = resourceEntry(state, definition, owner);
  if (!entry) return false;
  return entry.available === undefined ? true : !!entry.available;
}

/**
 * Can this much be spent right now?
 *
 * Returns `{ ok, reason }` rather than a boolean, because "you cannot do that"
 * with no explanation is the worst thing a tactics game can say.
 */
export function canSpendResource(state, definition, owner, amount) {
  const entry = resourceEntry(state, definition, owner);
  if (!entry) return { ok: false, reason: 'no "' + (definition ? definition.id : "?") + '" here' };
  if (entry.available === false) {
    return { ok: false, reason: (definition.name || definition.id) + " is not available" };
  }
  if (entry.current < amount) {
    return {
      ok: false,
      reason:
        "not enough " + (definition.name || definition.id) +
        " (" + entry.current + " of " + amount + " needed)"
    };
  }
  return { ok: true, reason: null };
}

export function spendResource(state, definition, owner, amount) {
  const check = canSpendResource(state, definition, owner, amount);
  if (!check.ok) return false;
  resourceEntry(state, definition, owner).current -= amount;
  return true;
}

/** Adds points, capped at max. Returns how many actually landed. */
export function gainResource(state, definition, owner, amount) {
  const entry = resourceEntry(state, definition, owner);
  if (!entry) return 0;
  const before = entry.current;
  entry.current = clamp(entry.current + amount, 0, entry.max);
  return entry.current - before;
}

export function setResource(state, definition, owner, value) {
  const entry = resourceEntry(state, definition, owner);
  if (!entry) return false;
  entry.current = clamp(value, 0, entry.max);
  return true;
}

/**
 * Marks a resource usable or not, for every owner it has.
 *
 * Coming back online refills by default: a link that reforms mid-battle should
 * be immediately useful rather than inheriting whatever was left when it
 * lapsed. Pass `{ preserve: true }` for a gate that should not.
 */
export function setResourceAvailable(state, definition, available, options) {
  if (!definition || definition.scope !== "faction") return false;
  let changed = false;
  for (const teamId of Object.keys(state.resources.faction)) {
    const entry = state.resources.faction[teamId][definition.id];
    if (!entry) continue;
    const was = entry.available;
    entry.available = !!available;
    if (was !== entry.available) changed = true;
    if (!was && entry.available && !(options && options.preserve)) entry.current = entry.max;
  }
  return changed;
}

/* ---------------------------------------------------------------
 * REGENERATION
 * -------------------------------------------------------------*/

/**
 * Applies every `*Activation` regeneration triggered by a unit activating.
 *
 * `ownerUnitIds` maps a resource id to the units that count as its owners —
 * for a link-gated resource that is the link's participants. A resource with
 * no entry there is owned by everyone on its faction.
 */
export function regenerateOnActivation(state, definitions, unitId, ownerUnitIds) {
  const unit = state.units[unitId];
  if (!unit) return [];
  const applied = [];

  for (const raw of definitions || []) {
    const definition = normalizeResourceDefinition(raw);
    if (!definition.regen || definition.regen.on === "manual") continue;
    const amount = definition.regen.amount;

    if (definition.scope === "unit") {
      if (definition.regen.on === "selfActivation") {
        const gained = gainResource(state, definition, { unitId }, amount);
        if (gained) applied.push({ id: definition.id, owner: unitId, gained });
      }
      continue;
    }

    const owners = ownerUnitIds ? ownerUnitIds[definition.id] : null;
    if (owners && !owners.includes(unitId)) continue;
    if (!owners && definition.regen.on === "selfActivation") continue;
    if (!resourceIsAvailable(state, definition, { teamId: unit.teamId })) continue;
    const gained = gainResource(state, definition, { teamId: unit.teamId }, amount);
    if (gained) applied.push({ id: definition.id, owner: unit.teamId, gained });
  }
  return applied;
}

/* ---------------------------------------------------------------
 * PRESENTATION
 * -------------------------------------------------------------*/

/** Snapshot for the HUD. Never mutates. */
export function describeResources(state, definitions, options) {
  const teamId = (options && options.teamId) || null;
  const unitIds = (options && options.unitIds) || [];
  const out = { faction: [], unit: [] };

  for (const raw of definitions || []) {
    const definition = normalizeResourceDefinition(raw);
    if (definition.scope === "faction") {
      if (!teamId) continue;
      const entry = resourceEntry(state, definition, { teamId });
      if (!entry) continue;
      out.faction.push({
        id: definition.id,
        name: definition.name || definition.id,
        current: entry.current,
        max: entry.max,
        available: entry.available !== false,
        linkId: definition.linkId
      });
      continue;
    }
    for (const unitId of unitIds) {
      const entry = resourceEntry(state, definition, { unitId });
      if (!entry) continue;
      out.unit.push({
        id: definition.id,
        name: definition.name || definition.id,
        unitId,
        current: entry.current,
        max: entry.max
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------
 * VALIDATION
 * -------------------------------------------------------------*/

export function validateResourceDefinition(raw, path) {
  const where = path || "resource";
  const problems = [];
  if (!raw || typeof raw !== "object") return [where + " must be an object."];
  const entry = raw;

  if (!entry.id || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(entry.id)) {
    problems.push(where + " needs a stable slug id.");
  }
  if (entry.scope && !RESOURCE_SCOPES.includes(entry.scope)) {
    problems.push(where + ' has unknown scope "' + entry.scope + '" (unit, faction).');
  }
  const max = Number(entry.max);
  if (!Number.isFinite(max) || max <= 0) {
    problems.push(where + " needs a maximum of at least 1.");
  }
  if (entry.startsAt != null) {
    const startsAt = Number(entry.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < 0) {
      problems.push(where + " cannot start below zero.");
    } else if (Number.isFinite(max) && startsAt > max) {
      problems.push(where + " starts at " + startsAt + ", above its maximum of " + max + ".");
    }
  }
  if (entry.regen) {
    if (!REGEN_TRIGGERS.includes(entry.regen.on)) {
      problems.push(
        where + ' regenerates on unknown trigger "' + entry.regen.on + '" (' + REGEN_TRIGGERS.join(", ") + ').'
      );
    }
    const amount = Number(entry.regen.amount == null ? 1 : entry.regen.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      problems.push(where + " regenerates by a non-positive amount, which would never do anything.");
    }
    if (entry.scope === "unit" && entry.regen.on === "ownerActivation") {
      problems.push(
        where + " is unit-scoped, so it regenerates on selfActivation rather than ownerActivation."
      );
    }
  }
  return problems;
}
