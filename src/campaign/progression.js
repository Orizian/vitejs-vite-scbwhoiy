/* =========================================================================
 * CAMPAIGN PROGRESSION
 *
 * Which operations are offered, what completing one changes, and how a
 * campaign's shape is checked.
 *
 * The contract this module exists to enforce:
 *
 *   Campaign content is authored data.
 *   Campaign runtime consumes campaign content.
 *   Campaign runtime does not own campaign definitions.
 *
 * Every function here takes the campaign *content* as an argument. None of
 * them import it. That is the whole difference between a campaign engine and
 * one campaign that happens to run: the tests drive a three-node synthetic
 * campaign through these same functions, with no mission, operator or flag
 * name that this project ships.
 *
 * DERIVED EDGES. A campaign graph is not authored twice. A node declares what
 * it `requires` (flags) and what it `grantsFlags`; every dependency edge in
 * the editor, the validator and the reachability analysis is derived from
 * those two lists. The prototype carried an `unlocks` array as well — empty on
 * all thirteen missions, read by two display sites — and a second graph
 * authority that nobody maintained is exactly how a campaign editor starts
 * lying about the game.
 *
 * Pure data and pure functions. No React, no engine, no content ids.
 * =======================================================================*/

/**
 * What a node may demand before it is offered.
 *
 * One kind, because one kind is what the prototype uses: a campaign flag that
 * has been set. The registry shape is the point — a second requirement kind
 * (a rank, a facility, an owned operator) is a new entry here and a new
 * clause in authored data, not a new branch at every call site.
 */
export const REQUIREMENT_KINDS = {
  flag: {
    label: "Campaign flag",
    summary: "A flag some earlier node granted is set.",
    /** @returns {boolean} */
    holds: (requirement, state) => state.flags[requirement.flag] === true,
    describe: (requirement) => requirement.flag,
    /** Which flags this requirement waits on, for edge derivation. */
    flags: (requirement) => [requirement.flag]
  }
};

export const REQUIREMENT_KIND_IDS = Object.keys(REQUIREMENT_KINDS);

/**
 * Authored requirements accept a bare string as shorthand for a flag.
 *
 * The prototype authored `requires: ["quarryReached"]` and there is no reason
 * to make that longer now that it is a file. The long form
 * `{ kind: "flag", flag: "quarryReached" }` is what a second kind will need,
 * and both normalize to the same thing.
 */
export function normalizeRequirement(raw) {
  if (typeof raw === "string") return { kind: "flag", flag: raw };
  if (!raw || typeof raw !== "object") return null;
  return { kind: raw.kind || "flag", ...raw };
}

export function normalizeRequirements(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeRequirement).filter(Boolean);
}

/* ---------------------------------------------------------------
 * NODES
 * -------------------------------------------------------------*/

/** Fills in a node's defaults so nothing downstream checks for absent fields. */
export function normalizeNode(raw, id) {
  const node = { ...(raw || {}) };
  node.id = node.id || id || null;
  node.missionId = node.missionId || null;
  node.order = Number(node.order) || 0;
  node.requires = normalizeRequirements(node.requires);
  node.grantsFlags = Array.isArray(node.grantsFlags) ? node.grantsFlags.slice() : [];
  node.recruits = Array.isArray(node.recruits) ? node.recruits.slice() : [];
  node.contacts = Array.isArray(node.contacts) ? node.contacts.slice() : [];
  // Editor-only. Deliberately kept beside the node rather than inside it, so
  // it is obvious at a glance that nothing in the runtime may read it: mission
  // order must never depend on pixels.
  node.editor = node.editor && typeof node.editor === "object" ? { ...node.editor } : null;
  return node;
}

/**
 * Every node, in presentation order.
 *
 * Sorted by authored `order` and then by id, so two nodes sharing an order —
 * which the prototype's branch does — still come out in a stable sequence.
 */
export function orderedNodes(content) {
  return Object.keys(content.nodes || {})
    .map((id) => content.nodes[id])
    .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
}

/* ---------------------------------------------------------------
 * AVAILABILITY
 * -------------------------------------------------------------*/

/**
 * Whether one requirement currently holds, and why it does not.
 *
 * Returns a record rather than a boolean because the editor's preview and the
 * player's locked-mission tooltip both need the reason, and deriving it twice
 * is how two explanations start disagreeing.
 */
export function evaluateRequirement(requirement, state) {
  const kind = REQUIREMENT_KINDS[requirement.kind];
  if (!kind) {
    return { held: false, kind: requirement.kind, label: requirement.kind, reason: "unknownRequirement" };
  }
  const held = kind.holds(requirement, state) === true;
  return {
    held,
    kind: requirement.kind,
    label: kind.describe(requirement),
    reason: held ? null : "unmet"
  };
}

/** Why a node is or is not offered right now. */
export function nodeAvailability(content, state, nodeId) {
  const node = (content.nodes || {})[nodeId];
  if (!node) return { nodeId, available: false, reason: "unknownNode", requirements: [] };
  const requirements = node.requires.map((requirement) => evaluateRequirement(requirement, state));
  const unmet = requirements.filter((entry) => !entry.held);
  const completed = (state.completed || []).includes(nodeId);
  return {
    nodeId,
    completed,
    // Completion hides a node from the *available* list, which is what the
    // prototype did and what the board still shows. Replayability is a
    // separate question the reward layer already answers.
    available: !completed && !unmet.length,
    reason: completed ? "completed" : unmet.length ? "requirementsUnmet" : null,
    requirements,
    unmet: unmet.map((entry) => entry.label)
  };
}

export function availableNodeIds(content, state) {
  return orderedNodes(content)
    .filter((node) => nodeAvailability(content, state, node.id).available)
    .map((node) => node.id);
}

/* ---------------------------------------------------------------
 * GRAPH
 * -------------------------------------------------------------*/

/**
 * Dependency edges, derived rather than authored.
 *
 * An edge runs from whichever node grants a flag to whichever node requires
 * it. A node whose requirement no node grants produces a `dangling` edge with
 * no source, which is how the validator and the editor both report an
 * unsatisfiable prerequisite without inventing a second representation.
 */
export function deriveEdges(content) {
  const granters = {};
  for (const node of orderedNodes(content)) {
    for (const flag of node.grantsFlags) {
      if (!granters[flag]) granters[flag] = [];
      granters[flag].push(node.id);
    }
  }
  const edges = [];
  for (const node of orderedNodes(content)) {
    for (const requirement of node.requires) {
      const kind = REQUIREMENT_KINDS[requirement.kind];
      const flags = kind && kind.flags ? kind.flags(requirement) : [];
      for (const flag of flags) {
        const sources = granters[flag] || [];
        if (!sources.length) {
          edges.push({ from: null, to: node.id, flag, dangling: true });
          continue;
        }
        for (const from of sources) edges.push({ from, to: node.id, flag, dangling: false });
      }
    }
  }
  return edges;
}

/** Nodes nothing depends on reaching — where a playthrough can begin. */
export function rootNodeIds(content) {
  return orderedNodes(content)
    .filter((node) => !node.requires.length)
    .map((node) => node.id);
}

/**
 * Which nodes a playthrough could ever reach, by walking forward from the
 * roots and accumulating granted flags until nothing new opens.
 *
 * A bounded fixpoint, not a solver: it assumes every reachable node is
 * eventually completed, which is the right assumption for "can an author's
 * campaign be finished at all" and the wrong one for anything subtler. That
 * limit is deliberate — §31 asks for reachability, not a theorem prover.
 */
export function reachability(content) {
  const nodes = orderedNodes(content);
  const reached = new Set();
  const flags = new Set(content.startingFlags || []);
  let grew = true;
  let passes = 0;
  while (grew && passes <= nodes.length + 1) {
    grew = false;
    passes += 1;
    for (const node of nodes) {
      if (reached.has(node.id)) continue;
      const satisfied = node.requires.every((requirement) => {
        const kind = REQUIREMENT_KINDS[requirement.kind];
        if (!kind || !kind.flags) return false;
        return kind.flags(requirement).every((flag) => flags.has(flag));
      });
      if (!satisfied) continue;
      reached.add(node.id);
      for (const flag of node.grantsFlags) flags.add(flag);
      grew = true;
    }
  }
  return {
    reachable: Array.from(reached),
    unreachable: nodes.map((node) => node.id).filter((id) => !reached.has(id)),
    grantedFlags: Array.from(flags).sort()
  };
}

/**
 * Cycles in the derived graph.
 *
 * A campaign cycle is not a crash — the fixpoint above simply never reaches
 * the nodes involved — but it is always an authoring mistake, and saying
 * "these three nodes wait on each other" is far more useful than saying
 * "three nodes are unreachable".
 */
export function findNodeCycles(content) {
  const outgoing = {};
  for (const edge of deriveEdges(content)) {
    if (edge.dangling) continue;
    if (!outgoing[edge.from]) outgoing[edge.from] = [];
    if (!outgoing[edge.from].includes(edge.to)) outgoing[edge.from].push(edge.to);
  }
  const cycles = [];
  const state = {};
  const walk = (id, stack) => {
    if (state[id] === "done") return;
    if (state[id] === "open") {
      cycles.push(stack.slice(stack.indexOf(id)).concat(id));
      return;
    }
    state[id] = "open";
    for (const next of outgoing[id] || []) walk(next, stack.concat(id));
    state[id] = "done";
  };
  for (const node of orderedNodes(content)) walk(node.id, []);
  return cycles;
}

/* ---------------------------------------------------------------
 * VALIDATION
 * -------------------------------------------------------------*/

/**
 * Everything statically wrong with a campaign.
 *
 * `refs` supplies the id sets to check against — missions, operators,
 * facilities, contacts, currencies. A caller that only has some of them passes
 * only those, and the rest go unchecked rather than falsely failing.
 */
export function validateCampaign(content, refs) {
  const errors = [];
  const warnings = [];
  const known = refs || {};
  const nodes = orderedNodes(content);

  if (!content.id) errors.push("The campaign has no id.");
  if (!content.name) warnings.push("The campaign has no display name.");

  for (const node of nodes) {
    const where = 'campaign node "' + node.id + '"';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(node.id))) {
      errors.push(where + " has an id that is not a stable slug.");
    }
    if (!node.missionId) {
      errors.push(where + " references no mission.");
    } else if (known.missionIds && !known.missionIds.includes(node.missionId)) {
      errors.push(where + ' references unknown mission "' + node.missionId + '".');
    }
    // Ownership. Rewards belong to mission content; a node that tries to
    // redefine them would be a second authority, which is the thing the reward
    // phase spent its whole budget removing.
    if (node.rewards) {
      errors.push(
        where + " defines rewards. Mission content owns what a mission pays; " +
          "the campaign says when it is offered."
      );
    }
    for (const requirement of node.requires) {
      if (!REQUIREMENT_KINDS[requirement.kind]) {
        errors.push(
          where + ' has an unknown requirement kind "' + requirement.kind + '" (' +
            REQUIREMENT_KIND_IDS.join(", ") + ")."
        );
        continue;
      }
      if (requirement.kind === "flag" && !requirement.flag) {
        errors.push(where + " has a flag requirement naming no flag.");
      }
    }
    const seenFlags = new Set();
    for (const requirement of node.requires) {
      const key = requirement.kind + ":" + (requirement.flag || "");
      if (seenFlags.has(key)) warnings.push(where + " lists the same requirement twice.");
      seenFlags.add(key);
    }
    for (const operatorId of node.recruits) {
      if (known.operatorIds && !known.operatorIds.includes(operatorId)) {
        errors.push(where + ' recruits unknown operator "' + operatorId + '".');
      }
    }
    for (const contactId of node.contacts) {
      if (known.contactIds && !known.contactIds.includes(contactId)) {
        errors.push(where + ' introduces unknown contact "' + contactId + '".');
      }
    }
    const deployment = node.deployment;
    if (deployment) {
      const rosterRefs = (deployment.requiredOperatorIds || [])
        .concat(deployment.optionalOperatorIds || [])
        .concat(deployment.deploymentOrder || [])
        .concat((deployment.guestOperators || []).map((guest) => guest.operatorId));
      for (const operatorId of rosterRefs) {
        if (known.operatorIds && !known.operatorIds.includes(operatorId)) {
          errors.push(where + ' deploys unknown operator "' + operatorId + '".');
        }
      }
      const size = deployment.deploymentSize;
      if (size != null && !(Number(size) > 0)) {
        errors.push(where + " has a deployment size that is not positive.");
      }
      if (size != null && (deployment.requiredOperatorIds || []).length > Number(size)) {
        errors.push(where + " requires more operators than it may deploy.");
      }
    }
  }

  /* ---- graph ---- */
  for (const edge of deriveEdges(content)) {
    if (edge.dangling) {
      errors.push(
        'campaign node "' + edge.to + '" waits on flag "' + edge.flag +
          '", which no node grants. Nothing will ever offer it.'
      );
    }
    if (edge.from === edge.to) {
      errors.push('campaign node "' + edge.to + '" waits on a flag it grants itself.');
    }
  }
  for (const cycle of findNodeCycles(content)) {
    errors.push("Campaign nodes wait on each other in a cycle: " + cycle.join(" → ") + ".");
  }
  if (nodes.length && !rootNodeIds(content).length) {
    errors.push("No campaign node is available at the start, so the campaign cannot begin.");
  }
  for (const nodeId of reachability(content).unreachable) {
    warnings.push('campaign node "' + nodeId + '" can never be reached.');
  }

  /* ---- facilities, contacts, currencies ---- */
  for (const [facilityId, facility] of Object.entries(content.facilities || {})) {
    const where = 'facility "' + facilityId + '"';
    if (!facility.name) warnings.push(where + " has no display name.");
    for (const currencyId of Object.keys(facility.cost || {})) {
      if (known.currencyIds && !known.currencyIds.includes(currencyId)) {
        errors.push(where + ' costs unknown currency "' + currencyId + '".');
      }
    }
  }
  for (const [contactId, contact] of Object.entries(content.contacts || {})) {
    if (!contact.name) warnings.push('contact "' + contactId + '" has no display name.');
  }
  for (const operatorId of content.startingRoster || []) {
    if (known.operatorIds && !known.operatorIds.includes(operatorId)) {
      errors.push('The starting roster names unknown operator "' + operatorId + '".');
    }
  }
  for (const currencyId of Object.keys(content.startingCurrencies || {})) {
    if (known.currencyIds && !known.currencyIds.includes(currencyId)) {
      errors.push('The campaign starts with unknown currency "' + currencyId + '".');
    }
  }

  return { ok: !errors.length, errors, warnings };
}
