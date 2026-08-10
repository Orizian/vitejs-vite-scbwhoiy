/* =========================================================================
 * COMBAT LINKS
 *
 * A Link is a named combat relationship between named units. It owns a set of
 * reactions, and any resource that names it is available only while it holds.
 *
 * This is not a social-link system. It has no affinity, no levels and no
 * out-of-combat progression. It answers one question each time the battle
 * changes: are these specific units currently able to fight as a unit?
 *
 * Three independent gates, all serializable:
 *
 *   unlocked   narrative/campaign state. Act I has Section Seven unlocked;
 *              Acts II–III do not; Grayfield re-unlocks it mid-battle through
 *              an ordinary mission action.
 *   enabled    battle-local switch, which is what mission scripting toggles.
 *   active     derived every re-evaluation: are all participants present,
 *              alive, actionable and mutually allied?
 *
 * A link is usable only when all three hold. Nothing about any particular link
 * is known to the engine — each is one entry in a content table.
 * =======================================================================*/

export function createLinkState(linkDefinitions, options) {
  const unlockedIds = new Set((options && options.unlockedLinkIds) || []);
  const links = {};
  for (const link of linkDefinitions || []) {
    links[link.id] = {
      // A link with `unlockedByDefault` is available unless the campaign says
      // otherwise; anything else must be unlocked explicitly.
      unlocked: unlockedIds.has(link.id) || link.unlockedByDefault === true,
      enabled: link.enabledByDefault !== false,
      active: false,
      /** Why it is inactive, for the HUD and for tests. */
      reason: "not evaluated",
      participantUnitIds: []
    };
  }
  return links;
}

/**
 * Recomputes every link's `active` flag against current battle state.
 *
 * Called after anything that could change the answer: a defeat, a faction
 * change, a spawn, a mission action. Cheap — it is a handful of lookups per
 * link, and there are a handful of links.
 *
 * @returns ids of links whose active flag changed
 */
export function evaluateLinks(linkState, linkDefinitions, view) {
  const changed = [];

  for (const link of linkDefinitions || []) {
    const entry = linkState[link.id];
    if (!entry) continue;
    const was = entry.active;

    const result = evaluateLink(link, entry, view);
    entry.active = result.active;
    entry.reason = result.reason;
    entry.participantUnitIds = result.participantUnitIds;

    if (was !== entry.active) changed.push(link.id);
  }

  return changed;
}

function evaluateLink(link, entry, view) {
  const participantUnitIds = [];
  for (const ref of link.participants || []) {
    const unitId = view.unitIdByRef(ref);
    if (unitId) participantUnitIds.push(unitId);
  }

  if (!entry.unlocked) {
    return { active: false, reason: "not unlocked", participantUnitIds };
  }
  if (!entry.enabled) {
    return { active: false, reason: "disabled", participantUnitIds };
  }

  const required = (link.participants || []).length;
  const needAll = link.requireAll !== false;
  if (needAll && participantUnitIds.length < required) {
    return { active: false, reason: "not all participants are deployed", participantUnitIds };
  }
  if (!participantUnitIds.length) {
    return { active: false, reason: "no participants on the field", participantUnitIds };
  }

  // A destroyed or dormant participant breaks the link. This is the whole
  // answer to "what happens if one of them goes down": the link deactivates,
  // its reactions stop being legal, and any resource it gates goes unavailable.
  const actionable = participantUnitIds.filter((unitId) => view.unitIsActionable(unitId));
  if (needAll && actionable.length < required) {
    return { active: false, reason: "a participant is down or dormant", participantUnitIds };
  }

  if (link.requireMutuallyAllied !== false) {
    for (let i = 0; i < participantUnitIds.length; i += 1) {
      for (let j = i + 1; j < participantUnitIds.length; j += 1) {
        if (view.relationship(participantUnitIds[i], participantUnitIds[j]) !== "allied") {
          return { active: false, reason: "participants are not allied", participantUnitIds };
        }
      }
    }
  }

  return { active: true, reason: "active", participantUnitIds };
}

export function isLinkActive(linkState, linkId) {
  const entry = linkState && linkState[linkId];
  return !!(entry && entry.active);
}

/** Sets the battle-local switch. Mission scripting's `setLinkState` calls this. */
export function setLinkEnabled(linkState, linkId, enabled) {
  const entry = linkState && linkState[linkId];
  if (!entry) return false;
  if (entry.enabled === !!enabled) return false;
  entry.enabled = !!enabled;
  return true;
}

/** Sets the narrative gate. Campaign progression and mission scripting both
 *  use this; the distinction from `enabled` is that unlocking is the thing
 *  that persists past the battle. */
export function setLinkUnlocked(linkState, linkId, unlocked) {
  const entry = linkState && linkState[linkId];
  if (!entry) return false;
  if (entry.unlocked === !!unlocked) return false;
  entry.unlocked = !!unlocked;
  return true;
}

/**
 * Resource ids gated by a link, mapped to the units currently able to draw on
 * them.
 *
 * A resource declares `linkId`; the link declares its participants. Neither
 * knows the other's shape, and the resource layer uses this purely for refresh
 * scoping — it never asks what a link is.
 */
export function resourceOwnership(linkState, linkDefinitions, resourceDefinitions) {
  const owners = {};
  for (const resource of resourceDefinitions || []) {
    if (!resource.linkId) continue;
    const entry = linkState[resource.linkId];
    owners[resource.id] = entry ? entry.participantUnitIds.slice() : [];
  }
  return owners;
}

/** HUD model. Presentation reads this; it never computes activity itself.
 *  `resourceLookup(linkId)` supplies the gated resources, so this module still
 *  needs to know nothing about how a balance is stored. */
export function describeLinks(linkState, linkDefinitions, resourceLookup) {
  return (linkDefinitions || []).map((link) => {
    const entry = linkState[link.id] || {};
    return {
      id: link.id,
      name: link.name || link.id,
      icon: link.icon || "◈",
      description: link.description || "",
      unlocked: !!entry.unlocked,
      enabled: !!entry.enabled,
      active: !!entry.active,
      reason: entry.reason || "",
      participants: link.participants || [],
      participantUnitIds: entry.participantUnitIds || [],
      resources: resourceLookup ? resourceLookup(link.id) : []
    };
  });
}
