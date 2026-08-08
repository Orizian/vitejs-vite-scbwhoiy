/* =========================================================================
 * FACTION RELATIONSHIPS
 *
 * Replaces the old rule that any two different team ids are automatically
 * enemies. Relationships live in battle state, so they serialize with a save
 * and can be rewritten mid-battle without recreating a single unit.
 *
 * The matrix is stored asymmetrically (relationships[a][b]) because that costs
 * nothing and one-way hostility is a real thing — a hunter unit that attacks
 * civilians while the civilians simply flee. Every mutation is symmetric by
 * default, so authors never have to think about it unless they want to.
 *
 * Pure data. No engine imports, so the editor can validate against it.
 * =======================================================================*/

export const RELATIONSHIPS = ["allied", "neutral", "hostile"];

export const RELATIONSHIP_LABELS = {
  allied: "Allied — will not attack, counts as a friendly target",
  neutral: "Neutral — will not attack and will not be attacked",
  hostile: "Hostile — valid target on both sides"
};

/** `protected` is authoring shorthand rather than a fourth relationship: a
 *  protected faction is neutral to everyone that is not explicitly hostile to
 *  it. Kept as an alias so mission data can say what it means. */
export const RELATIONSHIP_ALIASES = { protected: "neutral", nonHostile: "neutral" };

export function normalizeRelationship(value) {
  if (!value) return null;
  const aliased = RELATIONSHIP_ALIASES[value] || value;
  return RELATIONSHIPS.includes(aliased) ? aliased : null;
}

/**
 * Builds the starting matrix.
 *
 * Backward compatibility is the important property here: an encounter that
 * says nothing about factions gets exactly the old behaviour — same team is
 * allied, every other team is hostile — so all existing content keeps working.
 */
export function createFactionState(teamIds, authored) {
  const relationships = {};
  for (const a of teamIds) {
    relationships[a] = {};
    for (const b of teamIds) {
      relationships[a][b] = a === b ? "allied" : "hostile";
    }
  }

  for (const entry of (authored && authored.relationships) || []) {
    const relationship = normalizeRelationship(entry.relationship);
    if (!relationship) continue;
    if (!relationships[entry.a] || !relationships[entry.a][entry.b]) continue;
    relationships[entry.a][entry.b] = relationship;
    if (entry.symmetric !== false) relationships[entry.b][entry.a] = relationship;
  }

  return { relationships };
}

export function relationshipBetween(factionState, a, b) {
  if (!factionState || !factionState.relationships) return a === b ? "allied" : "hostile";
  const row = factionState.relationships[a];
  if (!row) return a === b ? "allied" : "hostile";
  const value = row[b];
  return value || (a === b ? "allied" : "hostile");
}

export function factionsHostile(factionState, a, b) {
  return relationshipBetween(factionState, a, b) === "hostile";
}

export function factionsAllied(factionState, a, b) {
  return relationshipBetween(factionState, a, b) === "allied";
}

/**
 * Mutates the matrix. Returns the list of changes actually applied, which is
 * empty when nothing moved — the caller uses that to suppress duplicate
 * `factionChanged` events when a script fires twice.
 */
export function setRelationship(factionState, a, b, relationship, options) {
  const normalized = normalizeRelationship(relationship);
  if (!normalized) return [];
  const symmetric = !(options && options.symmetric === false);
  const changes = [];

  const apply = (from, to) => {
    if (!factionState.relationships[from]) factionState.relationships[from] = {};
    const previous = relationshipBetween(factionState, from, to);
    if (previous === normalized) return;
    factionState.relationships[from][to] = normalized;
    changes.push({ a: from, b: to, from: previous, to: normalized });
  };

  apply(a, b);
  if (symmetric && a !== b) apply(b, a);
  return changes;
}

/** Every faction the given one is hostile toward. Used by AI target scoping
 *  and by the editor's relationship matrix view. */
export function hostileFactionsOf(factionState, teamId, allTeamIds) {
  return allTeamIds.filter((other) => factionsHostile(factionState, teamId, other));
}

/** Ensures a newly introduced team has a full row and column. Called when a
 *  scripted spawn introduces a faction the encounter never declared. */
export function ensureFaction(factionState, teamId, allTeamIds, defaultRelationship) {
  const fallback = normalizeRelationship(defaultRelationship) || "hostile";
  if (!factionState.relationships[teamId]) factionState.relationships[teamId] = {};
  for (const other of allTeamIds) {
    if (factionState.relationships[teamId][other] == null) {
      factionState.relationships[teamId][other] = teamId === other ? "allied" : fallback;
    }
    if (!factionState.relationships[other]) factionState.relationships[other] = {};
    if (factionState.relationships[other][teamId] == null) {
      factionState.relationships[other][teamId] = teamId === other ? "allied" : fallback;
    }
  }
  return factionState;
}
