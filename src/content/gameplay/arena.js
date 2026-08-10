/* =========================================================================
 * TEST ARENA
 *
 * Turning "I want to try this number" into a real battle.
 *
 * The Studio edits data; the only way to know whether a change is any good is
 * to play it. This module answers the awkward half of that: an ability is not
 * a thing you can deploy, and neither is a status or a perk, so pressing Test
 * on one has to resolve to *some* unit that exercises it. The rules below are
 * deterministic and stated out loud, because a test that quietly picked a
 * different subject than you assumed is worse than no test.
 *
 * What it does NOT do is run anything. It produces a mission document. The
 * battle is then created by the ordinary playtest path — same registry, same
 * compiler, same engine — so nothing here can invent a rule the game does not
 * already have.
 * =======================================================================*/

export const ARENA_MISSION_ID = "fixture-test-arena";

/** Refs in `fixture-test-arena.json` this module is allowed to rewrite. */
export const ARENA_SUBJECT_REF = "subject";
export const ARENA_FOE_REF = "durableTarget";

const sortedIds = (entries) => Object.keys(entries || {}).sort();

/** Does this entity mention `needle` anywhere in its authored values? */
function mentions(entity, needle) {
  let found = false;
  const walk = (value) => {
    if (found) return;
    if (typeof value === "string") {
      if (value === needle) found = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) walk(value[key]);
    }
  };
  walk(entity);
  return found;
}

function unitsWithAbility(data, abilityId) {
  return sortedIds(data.units).filter((id) =>
    ((data.units[id] || {}).abilities || []).includes(abilityId)
  );
}

function equipmentGranting(data, abilityId) {
  return sortedIds(data.equipment).filter((id) =>
    ((data.equipment[id] || {}).grantsAbilities || []).includes(abilityId)
  );
}

/** A chassis that is allowed to hold this part, preferring one that already does. */
function chassisForEquipment(data, equipmentId) {
  const part = (data.equipment || {})[equipmentId];
  if (!part) return null;
  const unitIds = sortedIds(data.units);
  const alreadyEquipped = unitIds.find(
    (id) => ((data.units[id] || {}).defaultEquipment || {})[part.slot] === equipmentId
  );
  if (alreadyEquipped) return alreadyEquipped;
  const allowed = part.compatibleClasses || [];
  if (!allowed.length) return unitIds[0] || null;
  return unitIds.find((id) => allowed.includes((data.units[id] || {}).classId)) || null;
}

/**
 * Which unit the arena should actually field, and why.
 *
 * Returns `{ ref, definitionId, equipment, subject, reason, caveat }`, or
 * `{ error }` when the registry offers nothing that exercises the entity. The
 * `reason` is shown to the author: the arena always says who it deployed.
 */
export function resolveTestSubject(data, kindId, id) {
  const registries = data || {};
  const fail = (message) => ({ error: message });

  if (kindId === "units") {
    const unit = (registries.units || {})[id];
    if (!unit) return fail('There is no unit "' + id + '".');
    return {
      ref: ARENA_SUBJECT_REF,
      definitionId: id,
      equipment: null,
      subject: id,
      reason: "Deploys " + (unit.name || id) + " with its default loadout."
    };
  }

  if (kindId === "operators") {
    const operator = (registries.operators || {})[id];
    if (!operator) return fail('There is no operator "' + id + '".');
    if (!operator.chassis || !(registries.units || {})[operator.chassis]) {
      return fail(
        (operator.name || id) + ' has no valid chassis, so there is nothing to deploy.'
      );
    }
    return {
      ref: ARENA_SUBJECT_REF,
      definitionId: operator.chassis,
      equipment: null,
      subject: operator.chassis,
      reason: "Deploys " + (operator.name || id) + "'s frame.",
      // Said plainly rather than discovered later: the arena is a battle, not
      // a campaign, so nothing here grants progression-time choices.
      caveat: "Perk choices are campaign progression and are not applied in the arena."
    };
  }

  if (kindId === "equipment") {
    const part = (registries.equipment || {})[id];
    if (!part) return fail('There is no equipment "' + id + '".');
    const chassis = chassisForEquipment(registries, id);
    if (!chassis) {
      return fail(
        (part.name || id) + " has no compatible chassis in the unit registry, so it cannot be fielded."
      );
    }
    const unit = registries.units[chassis];
    return {
      ref: ARENA_SUBJECT_REF,
      definitionId: chassis,
      equipment: { ...unit.defaultEquipment, [part.slot]: id },
      subject: chassis,
      reason: "Fits " + (part.name || id) + " to " + (unit.name || chassis) + " in the " + part.slot + " slot."
    };
  }

  if (kindId === "abilities") {
    const ability = (registries.abilities || {})[id];
    if (!ability) return fail('There is no ability "' + id + '".');
    const carriers = unitsWithAbility(registries, id);
    if (carriers.length) {
      const unit = registries.units[carriers[0]];
      return {
        ref: ARENA_SUBJECT_REF,
        definitionId: carriers[0],
        equipment: null,
        subject: carriers[0],
        reason:
          "Deploys " + (unit.name || carriers[0]) + ", which knows " + (ability.name || id) +
          (carriers.length > 1 ? " (" + carriers.length + " units do)." : ".")
      };
    }
    const granting = equipmentGranting(registries, id);
    for (const equipmentId of granting) {
      const nested = resolveTestSubject(registries, "equipment", equipmentId);
      if (!nested.error) {
        return {
          ...nested,
          reason:
            nested.reason + " " + (registries.equipment[equipmentId].name || equipmentId) +
            " grants " + (ability.name || id) + "."
        };
      }
    }
    return fail(
      (ability.name || id) + " is not on any unit and is not granted by any equipment, so nothing can use it yet."
    );
  }

  if (kindId === "statuses") {
    const status = (registries.statuses || {})[id];
    if (!status) return fail('There is no status "' + id + '".');
    const applier = sortedIds(registries.abilities).find((abilityId) =>
      mentions(registries.abilities[abilityId], id)
    );
    if (applier) {
      const nested = resolveTestSubject(registries, "abilities", applier);
      if (!nested.error) {
        return {
          ...nested,
          reason:
            nested.reason + " " + (registries.abilities[applier].name || applier) + " applies " +
            (status.name || id) + "."
        };
      }
    }
    return fail(
      (status.name || id) + " is not applied by any ability, so no battle can produce it."
    );
  }

  if (kindId === "aiProfiles") {
    const profile = (registries.aiProfiles || {})[id];
    if (!profile) return fail('There is no AI profile "' + id + '".');
    const user = sortedIds(registries.units).find(
      (unitId) => (registries.units[unitId] || {}).aiProfile === id
    );
    if (!user) {
      return fail(
        (profile.name || id) + " is not used by any unit, so no AI in the arena would run it."
      );
    }
    // The profile drives an opponent, not the unit you control, so it replaces
    // the arena's durable target instead of the subject.
    return {
      ref: ARENA_FOE_REF,
      definitionId: user,
      equipment: null,
      subject: user,
      reason:
        "Puts " + ((registries.units[user] || {}).name || user) + " opposite you, running " +
        (profile.name || id) + "."
    };
  }

  if (kindId === "perks") {
    const perk = (registries.perks || {})[id];
    if (!perk) return fail('There is no perk "' + id + '".');
    const owner = sortedIds(registries.operators).find((operatorId) =>
      ((registries.operators[operatorId] || {}).perkChoices || []).includes(id)
    );
    if (!owner) {
      return fail((perk.name || id) + " is not offered to any operator.");
    }
    const nested = resolveTestSubject(registries, "operators", owner);
    if (nested.error) return nested;
    return {
      ...nested,
      reason: nested.reason + " " + (perk.name || id) + " is one of their choices.",
      caveat:
        "Perks are chosen during campaign progression. The arena deploys the frame, not the perk."
    };
  }

  if (kindId === "reactions") {
    const reaction = (registries.reactions || {})[id];
    if (!reaction) return fail('There is no reaction "' + id + '".');
    if (reaction.owner) {
      const operatorId = sortedIds(registries.operators).find(
        (key) => ((registries.operators[key] || {}).ref || key) === reaction.owner
      );
      if (!operatorId) {
        return fail(
          (reaction.name || id) + ' is owned by "' + reaction.owner + '", who is not an operator.'
        );
      }
      const nested = resolveTestSubject(registries, "operators", operatorId);
      if (nested.error) return nested;
      return {
        ...nested,
        reason: nested.reason + " " + (reaction.name || id) + " is theirs to use.",
        caveat:
          "A reaction only fires when its trigger happens. The arena deploys the reactor; " +
          "you still have to cause a " + reaction.trigger + "."
      };
    }
    const required = reaction.requires && reaction.requires.status;
    const carrier = required
      ? sortedIds(registries.units).find((unitId) => mentions(registries.units[unitId], required))
      : null;
    if (carrier) {
      const nested = resolveTestSubject(registries, "units", carrier);
      if (!nested.error) {
        return {
          ...nested,
          reason: nested.reason + " It can hold " + required + ", which " + (reaction.name || id) + " needs.",
          caveat: "You still have to get the status on it and cause a " + reaction.trigger + "."
        };
      }
    }
    return fail(
      (reaction.name || id) + " has no owner and no unit obviously qualifies for it, so the arena " +
        "cannot guess who should be holding it."
    );
  }

  if (kindId === "combatLinks") {
    const link = (registries.combatLinks || {})[id];
    if (!link) return fail('There is no combat link "' + id + '".');
    const first = (link.participants || [])[0];
    const operatorId = first
      ? sortedIds(registries.operators).find(
          (key) => ((registries.operators[key] || {}).ref || key) === first
        )
      : null;
    if (!operatorId) {
      return fail((link.name || id) + " has no participant that maps to an operator.");
    }
    const nested = resolveTestSubject(registries, "operators", operatorId);
    if (nested.error) return nested;
    return {
      ...nested,
      reason: nested.reason + " They are the first participant in " + (link.name || id) + ".",
      caveat:
        "A link needs every participant deployed and allied. The arena fields one of them, " +
        "so the link itself will read as inactive."
    };
  }

  if (kindId === "resources") {
    const resource = (registries.resources || {})[id];
    if (!resource) return fail('There is no resource "' + id + '".');
    return fail(
      (resource.name || id) + " is a balance, not something that can be deployed. Test it through " +
        "a reaction or ability that spends it."
    );
  }

  if (kindId === "terrain") {
    return fail(
      "Terrain is measured by walking a map over it, not by deploying it. " +
      "Paint it into a mission in the map editor and playtest that."
    );
  }

  return fail('Nothing in the "' + kindId + '" registry can be deployed on its own.');
}

/**
 * The arena mission with the resolved subject swapped in.
 *
 * Keeps the fixture's id so the mission registry replaces the checked-in copy
 * rather than adding a second arena, and never touches anything but the one
 * unit under test — the rest of the layout is the measuring device.
 */
export function buildArenaMission(baseMission, plan) {
  const mission = JSON.parse(JSON.stringify(baseMission));
  const target = (mission.units || []).find((unit) => unit.ref === plan.ref);
  if (!target) {
    throw new Error('The arena has no unit with ref "' + plan.ref + '".');
  }
  target.definitionId = plan.definitionId;
  if (plan.equipment) target.equipment = { ...plan.equipment };
  else delete target.equipment;
  mission.name = "Test Arena · " + plan.subject;
  return mission;
}
