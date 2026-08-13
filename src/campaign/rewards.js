/* =========================================================================
 * REWARDS, DROPS AND LOOT TABLES
 *
 * What a mission pays, what a defeated enemy leaves behind, and the rules for
 * how often either may be collected.
 *
 * Four concepts, kept deliberately distinct even though they share one
 * pipeline. Collapsing them into a single `rewards` array would make the
 * interesting questions unanswerable — "why did I get this", "can I get it
 * again", "which enemy do I have to kill for it":
 *
 *   REWARD       something granted because an outcome occurred
 *   SOURCE       what caused it — a mission clear, or a defeated unit
 *   LOOT TABLE   a reusable authored definition of what a source can pay
 *   GRANT        one concrete payment: currency, equipment or material
 *
 * A table is resolved into grants; grants are collected into a receipt; the
 * receipt is applied to persistent progression exactly once. Planning never
 * mutates anything, which is what lets the results screen, the tests and the
 * actual application all read the same answer instead of three calculators
 * agreeing by coincidence.
 *
 * DETERMINISM. This module never calls `Math.random`, and deliberately does
 * not borrow the battle's random stream either. A stream would make loot
 * depend on how many dice combat happened to roll, and a reload would produce
 * different loot for an attempt that has already happened. Instead every roll
 * derives from a *key* — mission, attempt, source, table, roll index — hashed
 * into a number. The same attempt always rolls the same loot, from any
 * starting state, with no stored RNG.
 *
 * Pure data and pure functions. No engine, no React, no content ids.
 * =======================================================================*/

/** What a grant can pay out in. */
export const GRANT_KINDS = ["currency", "equipment", "material"];

/**
 * How often a grant may be collected.
 *
 * Two policies, not ten. `repeatable` is the farming case — replay the
 * mission, kill the thing, get another one. `oncePerCampaign` is the unique
 * case, and it is enforced by recording a claim key rather than by making the
 * item itself special, because "you may only ever receive this once" is a
 * property of the reward rule and not of the object.
 */
export const CLAIM_POLICIES = ["repeatable", "oncePerCampaign"];
export const DEFAULT_CLAIM_POLICY = "repeatable";

/** Where a reward came from. Preserved on every line of the receipt. */
export const SOURCE_KINDS = ["missionClear", "firstClear", "unitDefeated"];

/** Bounds nested table references. Deep enough for a shared family of tables,
 *  shallow enough that a cycle is caught long before a stack is. */
export const MAX_TABLE_DEPTH = 4;

/* ---------------------------------------------------------------
 * DETERMINISTIC ROLLS
 * -------------------------------------------------------------*/

/**
 * A stable 32-bit hash of a key string.
 *
 * The same mixing the battle RNG uses, applied to a key instead of to a
 * counter. That is the whole difference between "the fifth roll of this
 * battle" and "the first roll of this table on this attempt": one depends on
 * history, the other on identity, and only the second survives a reload.
 */
export function hashRollKey(key) {
  let h = 2166136261 >>> 0;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
  return (h ^ (h >>> 14)) >>> 0;
}

/** A number in [0,1) from a roll key. */
export function rollValue(key) {
  return hashRollKey(key) / 4294967296;
}

/**
 * The key one roll is identified by.
 *
 * Every component is authored or persistent: nothing here is derived from the
 * order events happened in, so two players who fought the same mission
 * differently on the same attempt still roll the same table.
 */
export function rollKey(parts) {
  return [
    parts.missionId || "-",
    parts.attempt == null ? 0 : parts.attempt,
    parts.sourceId || "-",
    parts.tableId || "-",
    parts.poolIndex == null ? 0 : parts.poolIndex,
    parts.rollIndex == null ? 0 : parts.rollIndex
  ].join("|");
}

/* ---------------------------------------------------------------
 * DEFINITIONS
 * -------------------------------------------------------------*/

/**
 * Fills in a loot table's defaults so nothing downstream checks for absent
 * fields. Unknown keys survive, so a field a future build adds round-trips.
 */
export function normalizeLootTable(raw, id) {
  const entry = { ...(raw || {}) };
  entry.id = entry.id || id || null;
  entry.guaranteed = (entry.guaranteed || []).map(normalizeGrant);
  entry.pools = (entry.pools || []).map((pool, index) => ({
    ...pool,
    id: pool.id || "pool" + (index + 1),
    rolls: pool.rolls == null ? 1 : Number(pool.rolls),
    entries: (pool.entries || []).map(normalizeGrant)
  }));
  return entry;
}

/**
 * One authored payment.
 *
 * `id` is required by validation rather than defaulted, because a claim key
 * built from an array index would silently retarget the moment an author
 * inserts a line above it — and the symptom would be a unique reward becoming
 * collectable again, months later, in somebody's save.
 */
function normalizeGrant(raw) {
  const entry = { ...(raw || {}) };
  entry.quantity = entry.quantity == null ? 1 : Number(entry.quantity);
  entry.weight = entry.weight == null ? 1 : Number(entry.weight);
  entry.claim = CLAIM_POLICIES.includes(entry.claim) ? entry.claim : DEFAULT_CLAIM_POLICY;
  return entry;
}

/* ---------------------------------------------------------------
 * PLANNING
 * -------------------------------------------------------------*/

/**
 * Resolves one table into grant lines, without touching anything.
 *
 * `context` supplies the identity the rolls hang off and the claim ledger to
 * check against; `tables` is the lookup for nested references. Returns lines
 * in a stable order — guaranteed first, then each pool in authored order —
 * so a receipt is reproducible and diffable.
 */
export function resolveLootTable(tables, tableId, context, depth, seen) {
  const level = depth || 0;
  const visited = seen || [];
  const lines = [];
  if (level >= MAX_TABLE_DEPTH) return lines;

  const raw = tables[tableId];
  if (!raw) {
    lines.push({
      ...lineIdentity(context, tableId, null),
      skipped: "unknownTable"
    });
    return lines;
  }
  // A cycle is a content error the validator refuses, but a draft in the
  // Studio can be mid-edit and still get previewed, so the runtime refuses to
  // follow one rather than trusting it never happens.
  if (visited.includes(tableId)) return lines;
  const table = normalizeLootTable(raw, tableId);
  const chain = visited.concat(tableId);

  for (const grant of table.guaranteed) {
    lines.push(...expandGrant(tables, grant, context, tableId, chain, level, null));
  }

  table.pools.forEach((pool, poolIndex) => {
    const rolls = Math.max(0, Math.floor(pool.rolls));
    const pickable = pool.entries.filter((entry) => Number(entry.weight) > 0);
    const total = pickable.reduce((sum, entry) => sum + Number(entry.weight), 0);
    if (!pickable.length || total <= 0) return;
    for (let rollIndex = 0; rollIndex < rolls; rollIndex += 1) {
      const key = rollKey({ ...context, tableId, poolIndex, rollIndex });
      const roll = rollValue(key);
      let cursor = roll * total;
      let chosen = pickable[pickable.length - 1];
      for (const entry of pickable) {
        cursor -= Number(entry.weight);
        if (cursor < 0) {
          chosen = entry;
          break;
        }
      }
      lines.push(
        ...expandGrant(tables, chosen, context, tableId, chain, level, {
          poolId: pool.id,
          rollIndex,
          rollKey: key,
          roll
        })
      );
    }
  });

  return lines;
}

/**
 * One authored grant becomes one or more receipt lines. A grant that names a
 * table instead of an item expands into that table's lines, which is how a
 * family of elite drops is authored once and referenced by several archetypes.
 */
function expandGrant(tables, grant, context, tableId, chain, level, roll) {
  if (!grant) return [];
  if (grant.tableId) {
    return resolveLootTable(tables, grant.tableId, context, level + 1, chain);
  }
  return [
    {
      ...lineIdentity(context, tableId, grant.id || null),
      kind: grant.kind || null,
      itemId: grant.itemId || null,
      quantity: Math.max(0, Math.floor(Number(grant.quantity) || 0)),
      claim: grant.claim,
      roll: roll || null
    }
  ];
}

/** The provenance every line carries, whether it landed or not. */
function lineIdentity(context, tableId, entryId) {
  return {
    sourceKind: context.sourceKind,
    sourceId: context.sourceId,
    sourceLabel: context.sourceLabel || null,
    missionId: context.missionId,
    attempt: context.attempt,
    tableId,
    entryId
  };
}

/**
 * The stable identity a once-per-campaign claim is recorded under.
 *
 * Deliberately excludes the attempt: the point of a claim is that it survives
 * across attempts. It includes the entry id rather than the item, so two
 * different unique rewards that happen to pay the same item are still two
 * different claims.
 */
export function claimKeyFor(line) {
  return [line.sourceKind, line.sourceId || "-", line.tableId || "-", line.entryId || "-"].join("::");
}

/**
 * Everything a completed mission attempt would pay, and why.
 *
 * Pure: `campaign` is read for claim history and never written. The result is
 * the single authority — the results screen renders it, the tests assert on
 * it, and `applyRewards` consumes it. There is no second calculator.
 *
 * `sources` is the caller's job to assemble, because *what counts as a source*
 * is a question about missions and battles that this module deliberately does
 * not have opinions about. It only knows how to resolve one.
 */
export function planRewards(input) {
  const tables = input.tables || {};
  const campaign = input.campaign || {};
  const claimed = campaign.rewardClaims || {};
  const lines = [];

  for (const source of input.sources || []) {
    const context = {
      sourceKind: source.kind,
      sourceId: source.id,
      sourceLabel: source.label || null,
      missionId: input.missionId,
      attempt: input.attempt
    };
    for (const tableId of source.tableIds || []) {
      lines.push(...resolveLootTable(tables, tableId, context, 0, []));
    }
  }

  // Claim policy and validity are decided after resolution rather than during
  // it, so a refused line still reports which table and roll produced it. A
  // reward you cannot collect is information; silently dropping it is not.
  const granted = [];
  const skipped = [];
  const seenClaims = new Set();
  for (const line of lines) {
    const refusal = refuseLine(line, input, claimed, seenClaims);
    if (refusal) {
      skipped.push({ ...line, skipped: refusal });
      continue;
    }
    if (line.claim === "oncePerCampaign") seenClaims.add(claimKeyFor(line));
    granted.push(line);
  }

  return {
    missionId: input.missionId,
    attempt: input.attempt,
    receiptId: receiptIdFor(input.missionId, input.attempt),
    granted,
    skipped,
    claims: granted.filter((line) => line.claim === "oncePerCampaign").map(claimKeyFor),
    totals: totalsOf(granted)
  };
}

function refuseLine(line, input, claimed, seenClaims) {
  if (line.skipped) return line.skipped;
  if (!GRANT_KINDS.includes(line.kind)) return "unknownGrantKind";
  if (!line.itemId) return "noItem";
  if (!(line.quantity > 0)) return "zeroQuantity";
  if (line.kind === "currency" && !(input.currencyIds || []).includes(line.itemId)) {
    return "unknownCurrency";
  }
  if (line.kind === "equipment" && !(input.equipmentIds || []).includes(line.itemId)) {
    return "unknownEquipment";
  }
  if (line.kind === "material" && !(input.materialIds || []).includes(line.itemId)) {
    return "unknownMaterial";
  }
  if (line.claim === "oncePerCampaign") {
    const key = claimKeyFor(line);
    if (claimed[key]) return "alreadyClaimed";
    // Two identical unique lines inside one receipt pay once, not twice.
    if (seenClaims.has(key)) return "alreadyClaimed";
  }
  return null;
}

function totalsOf(lines) {
  const totals = { currency: {}, equipment: {}, material: {} };
  for (const line of lines) {
    const bucket = totals[line.kind];
    if (!bucket) continue;
    bucket[line.itemId] = (bucket[line.itemId] || 0) + line.quantity;
  }
  return totals;
}

/**
 * The identity an applied receipt is recorded under.
 *
 * Mission and attempt, and nothing else. That is exactly the granularity
 * "exactly once" needs: the same attempt may be resolved any number of times
 * — a remount, a reload, a double-clicked button — and pays once; a genuinely
 * new attempt has a new number and may pay again.
 */
export function receiptIdFor(missionId, attempt) {
  return (missionId || "-") + "#" + (attempt == null ? 0 : attempt);
}

/* ---------------------------------------------------------------
 * APPLICATION
 * -------------------------------------------------------------*/

/**
 * Applies a receipt to persistent progression, once.
 *
 * Returns `{ campaign, applied, reason }`. Refusing to apply twice is not an
 * optimisation — currencies and material counts accumulate, so a second
 * application is a duplication bug that would be invisible until somebody
 * noticed they had twice the salvage they earned.
 *
 * The campaign is never mutated; a new one comes back, matching how every
 * other campaign transition in this project works.
 */
export function applyRewards(campaign, receipt) {
  const appliedReceipts = campaign.appliedReceipts || {};
  if (!receipt || !receipt.receiptId) {
    return { campaign, applied: false, reason: "noReceipt" };
  }
  if (appliedReceipts[receipt.receiptId]) {
    return { campaign, applied: false, reason: "alreadyApplied" };
  }

  const next = {
    ...campaign,
    inventory: { ...(campaign.inventory || {}) },
    materials: { ...(campaign.materials || {}) },
    rewardClaims: { ...(campaign.rewardClaims || {}) },
    appliedReceipts: { ...appliedReceipts, [receipt.receiptId]: true }
  };

  for (const line of receipt.granted || []) {
    if (line.kind === "currency") {
      next[line.itemId] = (Number(next[line.itemId]) || 0) + line.quantity;
    } else if (line.kind === "equipment") {
      next.inventory[line.itemId] = (next.inventory[line.itemId] || 0) + line.quantity;
    } else if (line.kind === "material") {
      next.materials[line.itemId] = (next.materials[line.itemId] || 0) + line.quantity;
    }
  }
  for (const key of receipt.claims || []) next.rewardClaims[key] = true;

  return { campaign: next, applied: true, reason: null };
}

/* ---------------------------------------------------------------
 * VALIDATION
 * -------------------------------------------------------------*/

/**
 * Static problems with one authored table. `refs` supplies the id sets to
 * check against; a caller that only has some of them passes only those, and
 * the rest go unchecked rather than falsely failing.
 */
export function validateLootTable(raw, path, refs) {
  const where = path || "loot table";
  const problems = [];
  if (!raw || typeof raw !== "object") return [where + " must be an object."];
  const table = normalizeLootTable(raw);
  const known = refs || {};
  const seenEntryIds = new Set();

  const checkGrant = (grant, at) => {
    if (!grant || typeof grant !== "object") {
      problems.push(at + " is not an object.");
      return;
    }
    if (grant.tableId) {
      if (known.tableIds && !known.tableIds.includes(grant.tableId)) {
        problems.push(at + ' references unknown loot table "' + grant.tableId + '".');
      }
      if (grant.kind || grant.itemId) {
        problems.push(at + " references a table and also names an item; it must do one or the other.");
      }
      return;
    }
    if (!grant.id) {
      problems.push(
        at + " needs a stable id. Claims and provenance are recorded against it, and an " +
          "array position would retarget the moment somebody inserts a line above."
      );
    } else if (seenEntryIds.has(grant.id)) {
      problems.push(at + ' reuses entry id "' + grant.id + '".');
    } else {
      seenEntryIds.add(grant.id);
    }
    if (!GRANT_KINDS.includes(grant.kind)) {
      problems.push(at + ' has unknown grant kind "' + grant.kind + '" (' + GRANT_KINDS.join(", ") + ').');
    }
    if (!grant.itemId) {
      problems.push(at + " names nothing to grant.");
    } else if (grant.kind === "equipment" && known.equipmentIds && !known.equipmentIds.includes(grant.itemId)) {
      problems.push(at + ' grants unknown equipment "' + grant.itemId + '".');
    } else if (grant.kind === "material" && known.materialIds && !known.materialIds.includes(grant.itemId)) {
      problems.push(at + ' grants unknown material "' + grant.itemId + '".');
    } else if (grant.kind === "currency" && known.currencyIds && !known.currencyIds.includes(grant.itemId)) {
      problems.push(at + ' grants unknown currency "' + grant.itemId + '".');
    }
    const quantity = Number(grant.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.floor(quantity) !== quantity) {
      problems.push(at + " needs a positive whole quantity.");
    }
    if (grant.claim != null && !CLAIM_POLICIES.includes(grant.claim)) {
      problems.push(at + ' has unknown claim policy "' + grant.claim + '" (' + CLAIM_POLICIES.join(", ") + ').');
    }
  };

  table.guaranteed.forEach((grant, index) => checkGrant(grant, where + " guaranteed " + (index + 1)));

  const seenPoolIds = new Set();
  table.pools.forEach((pool, poolIndex) => {
    const at = where + " pool " + (poolIndex + 1);
    if (pool.id) {
      if (seenPoolIds.has(pool.id)) problems.push(at + ' reuses pool id "' + pool.id + '".');
      seenPoolIds.add(pool.id);
    }
    const rolls = Number(pool.rolls);
    if (!Number.isFinite(rolls) || rolls < 0 || Math.floor(rolls) !== rolls) {
      problems.push(at + " needs a whole, non-negative roll count.");
    }
    if (!pool.entries.length) {
      problems.push(at + " has no entries, so its rolls can never produce anything.");
    }
    let positiveWeight = 0;
    pool.entries.forEach((grant, index) => {
      const entryAt = at + " entry " + (index + 1);
      const weight = Number(grant.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        problems.push(entryAt + " has a weight of zero or less, so it can never be rolled.");
      } else {
        positiveWeight += weight;
      }
      checkGrant(grant, entryAt);
    });
    if (rolls > 0 && positiveWeight <= 0) {
      problems.push(at + " rolls but nothing in it can be chosen.");
    }
  });

  return problems;
}

/**
 * A table that pays nothing.
 *
 * Reported separately from `validateLootTable` because it is a warning rather
 * than an error: a table is empty the moment it is created in the Studio, and
 * refusing to let an author start one would be worse than letting a pointless
 * one through. At runtime it resolves to no lines and harms nothing.
 */
export function lootTableIsEmpty(raw) {
  const table = normalizeLootTable(raw);
  return !table.guaranteed.length && !table.pools.length;
}

/**
 * Table references that form a cycle.
 *
 * Returns the ids involved, so the message can name them. A cycle is bounded
 * at runtime anyway, but an author who wrote one meant something else.
 */
export function findTableCycles(tables) {
  const cycles = [];
  const state = {};
  const walk = (id, stack) => {
    if (state[id] === "done") return;
    if (state[id] === "open") {
      cycles.push(stack.slice(stack.indexOf(id)).concat(id));
      return;
    }
    state[id] = "open";
    const table = normalizeLootTable(tables[id], id);
    const referenced = table.guaranteed
      .concat(...table.pools.map((pool) => pool.entries))
      .map((grant) => grant.tableId)
      .filter(Boolean);
    for (const next of referenced) {
      if (tables[next]) walk(next, stack.concat(id));
    }
    state[id] = "done";
  };
  for (const id of Object.keys(tables || {})) walk(id, []);
  return cycles;
}

/**
 * Every source that can pay a given item, derived from canonical content.
 *
 * This is the reverse index a future "where does this drop?" screen needs, and
 * it exists as a derivation rather than as authored text on the item precisely
 * so it cannot go stale. Nothing calls it in the game yet; the tests call it
 * to prove provenance is recoverable from the data alone.
 */
export function tablesGranting(tables, kind, itemId) {
  const direct = new Set();
  for (const [tableId, raw] of Object.entries(tables || {})) {
    const table = normalizeLootTable(raw, tableId);
    const grants = table.guaranteed.concat(...table.pools.map((pool) => pool.entries));
    if (grants.some((grant) => grant.kind === kind && grant.itemId === itemId)) direct.add(tableId);
  }
  // A table that references a granting table is itself a source of the item.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [tableId, raw] of Object.entries(tables || {})) {
      if (direct.has(tableId)) continue;
      const table = normalizeLootTable(raw, tableId);
      const grants = table.guaranteed.concat(...table.pools.map((pool) => pool.entries));
      if (grants.some((grant) => grant.tableId && direct.has(grant.tableId))) {
        direct.add(tableId);
        grew = true;
      }
    }
  }
  return Array.from(direct).sort();
}
