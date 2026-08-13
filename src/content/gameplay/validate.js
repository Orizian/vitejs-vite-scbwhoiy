/* =========================================================================
 * GAMEPLAY DATA VALIDATION
 *
 * Cross-registry invariants. Everything here is generic: the rules are stated
 * over registries and reference kinds, never over particular entity ids, so
 * adding a unit or an item cannot require adding a test.
 *
 * Errors block export. Warnings do not — the project's standing policy is that
 * missing artwork is a normal state for content in progress, and that policy
 * is kept rather than reinvented.
 * =======================================================================*/

import { REGISTRY_IDS, REGISTRY_KINDS } from "./format.js";
import { validateResourceDefinition, validateResourceQuery } from "../../combat/resources.js";
import {
  EFFECT_SCALING_SOURCE_IDS as EFFECT_SCALING_IDS,
  EFFECT_SCALING_MODES,
  STATUS_SCALING_SOURCES,
  EFFECT_RESOURCE_OWNERS,
  STATUS_TRIGGER_EVENT_IDS,
  STATUS_TRIGGER_TARGETS,
  statusTriggerHasCounterpart
} from "../../combat/authoring.js";
import { REDIRECT_IDS } from "../../combat/trajectory.js";
import { SELECTION_POLICY_IDS, MAX_PROPAGATION_HOPS } from "../../combat/propagation.js";
import { FIXTURE_STATES, FIXTURE_VISIBILITY } from "../../combat/fixtures.js";
import { HOSTILE_BARRIER_MODES, WINDOW_RELATIONSHIPS } from "../../combat/sequencing.js";

/** Trigger kinds the fixture runtime understands. */
const FIXTURE_TRIGGER_TYPES = ["unitEnters", "command"];
import { REACTION_EVENT_TYPE_IDS } from "../../reactions/events.js";
import { validateReactionEffect, INTERVENTION_EFFECT_TYPES } from "../../reactions/effects.js";
import { validateReactionCondition } from "../../reactions/conditions.js";

const EQUIPMENT_SLOTS = ["primaryWeapon", "armor", "utilitySystem", "coreSystem"];
const CHANNELS = ["optical", "thermal", "signal", "acoustic", "intel"];

function has(entries, id) {
  return !!(entries && Object.prototype.hasOwnProperty.call(entries, id));
}

function label(kindId, id) {
  const kind = REGISTRY_KINDS[kindId];
  return (kind ? kind.singular : kindId) + ' "' + id + '"';
}

/**
 * @param data      { units, abilities, equipment, statuses, aiProfiles, operators, perks }
 * @param context   optional external references: mission unit ids, scene ids…
 */
export function validateGameplayData(data, context) {
  const errors = [];
  const warnings = [];
  const registries = {};
  for (const kindId of REGISTRY_IDS) registries[kindId] = (data && data[kindId]) || {};

  const {
    units, abilities, equipment, statuses, aiProfiles, operators, perks, terrain,
    resources, reactions, combatLinks, fixtures
  } = registries;
  const external = context || {};

  /* ---- ids ---- */
  for (const kindId of REGISTRY_IDS) {
    for (const id of Object.keys(registries[kindId])) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
        errors.push(label(kindId, id) + " has an id that is not a stable slug.");
      }
      const entity = registries[kindId][id];
      if (!entity || typeof entity !== "object") {
        errors.push(label(kindId, id) + " is not an object.");
      }
    }
  }

  /* ---- units ---- */
  for (const id of Object.keys(units)) {
    const unit = units[id] || {};
    if (!unit.name) warnings.push(label("units", id) + " has no display name.");

    for (const abilityId of unit.abilities || []) {
      if (!has(abilities, abilityId)) {
        errors.push(label("units", id) + ' references unknown ability "' + abilityId + '".');
      }
    }
    if (unit.defaultAbilityId && !has(abilities, unit.defaultAbilityId)) {
      errors.push(
        label("units", id) + ' has default ability "' + unit.defaultAbilityId + '" which does not exist.'
      );
    }
    if (unit.defaultAbilityId && (unit.abilities || []).length && !(unit.abilities || []).includes(unit.defaultAbilityId)) {
      warnings.push(
        label("units", id) + " has a default ability it does not actually have."
      );
    }
    if (unit.aiProfile && !has(aiProfiles, unit.aiProfile)) {
      errors.push(label("units", id) + ' references unknown AI profile "' + unit.aiProfile + '".');
    }
    for (const slot of Object.keys(unit.defaultEquipment || {})) {
      const equipmentId = unit.defaultEquipment[slot];
      if (!equipmentId) continue;
      if (!EQUIPMENT_SLOTS.includes(slot)) {
        errors.push(label("units", id) + ' has default equipment in unknown slot "' + slot + '".');
      } else if (!has(equipment, equipmentId)) {
        errors.push(label("units", id) + ' defaults to unknown equipment "' + equipmentId + '".');
      } else {
        // The composition the game would actually perform, checked here rather
        // than reimplemented: a default loadout must be legal for its chassis.
        const item = equipment[equipmentId];
        if (item.slot !== slot) {
          errors.push(
            label("units", id) + ' installs "' + equipmentId + '" in ' + slot +
              " but that part is a " + item.slot + "."
          );
        }
        if ((item.compatibleClasses || []).length && !(item.compatibleClasses || []).includes(unit.classId)) {
          errors.push(
            label("units", id) + ' cannot field "' + equipmentId + '": it needs class ' +
              (item.compatibleClasses || []).join(" or ") + ' and this chassis is "' + (unit.classId || "none") + '".'
          );
        }
      }
    }
    validatePerception(unit.perception, label("units", id), errors);
    for (const key of ["portrait", "battlefield"]) {
      const asset = (unit.assets || {})[key];
      if (asset && external.assetIds && !external.assetIds.includes(asset)) {
        warnings.push(label("units", id) + ' names ' + key + ' asset "' + asset + '" which is not registered.');
      }
    }
  }

  /* ---- abilities ---- */
  /**
   * Every reference an effect can make, wherever the effect is authored.
   *
   * Recursive, because effects nest: a chain, a repeat and a conditional all
   * carry effect lists of their own, and a dangling status id is exactly as
   * broken one level down as it is at the top.
   */
  const checkEffectRefs = (effects, id, depth, kindId) => {
    if ((depth || 0) > 8) return;
    const owner = label(kindId || "abilities", id);
    for (const effect of effects || []) {
      if (!effect || typeof effect !== "object") continue;
      if (effect.statusId && !has(statuses, effect.statusId)) {
        errors.push(owner + ' applies unknown status "' + effect.statusId + '".');
      }
      if (effect.abilityId && !has(abilities, effect.abilityId)) {
        errors.push(owner + ' references unknown ability "' + effect.abilityId + '".');
      }
      // `definitionId` names whichever registry the effect draws from. A
      // fixture is not a unit, and saying "summons unknown unit" about a mine
      // sends the author looking in the wrong file.
      if (effect.definitionId && effect.type === "placeFixture") {
        if (!has(fixtures, effect.definitionId)) {
          errors.push(
            owner + ' places unknown fixture "' + effect.definitionId + '".'
          );
        }
      } else if (effect.definitionId && !has(units, effect.definitionId)) {
        errors.push(owner + ' summons unknown unit "' + effect.definitionId + '".');
      }
      if (effect.resourceId && !has(resources, effect.resourceId)) {
        errors.push(owner + ' moves unknown resource "' + effect.resourceId + '".');
      }
      checkScaling(effect.scaling, owner);
      checkEffectConditions(effect.conditions, owner + " condition");
      for (const key of ["effects", "ifTrue", "ifFalse"]) {
        if (Array.isArray(effect[key])) checkEffectRefs(effect[key], id, (depth || 0) + 1, kindId);
      }
    }
  };

  /**
   * Authored scaling: a named source, and whatever that source needs to read.
   *
   * A status source that names nothing reads zero forever, which is the kind of
   * mistake that looks like a balance problem for a week before anyone checks
   * the data.
   */
  const checkScaling = (scaling, where) => {
    const list = Array.isArray(scaling) ? scaling : scaling ? [scaling] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      if (!EFFECT_SCALING_IDS.includes(entry.from)) {
        errors.push(where + ' scales from unknown source "' + entry.from + '".');
        continue;
      }
      if (entry.mode != null && !EFFECT_SCALING_MODES.includes(entry.mode)) {
        errors.push(
          where + ' scales in unknown mode "' + entry.mode + '" (' + EFFECT_SCALING_MODES.join(", ") + ').'
        );
      }
      if (entry.perUnit != null && !Number.isFinite(Number(entry.perUnit))) {
        errors.push(where + " scales by a value that is not a number.");
      }
      if (STATUS_SCALING_SOURCES.includes(entry.from)) {
        if (!entry.statusId && !entry.statusTag) {
          errors.push(where + " scales from a status but names neither a status nor a tag.");
        }
        if (entry.statusId && !has(statuses, entry.statusId)) {
          errors.push(where + ' scales from unknown status "' + entry.statusId + '".');
        }
        if (entry.statusTag) {
          const carriers = Object.keys(statuses).filter((statusId) =>
            ((statuses[statusId] || {}).tags || []).includes(entry.statusTag)
          );
          if (!carriers.length) {
            errors.push(
              where + ' scales from statuses tagged "' + entry.statusTag + '", which nothing carries.'
            );
          }
        }
      }
    }
  };

  /** Effect conditions that reach outside the effect — currently balances. */
  const checkEffectConditions = (conditions, where) => {
    const entries = Array.isArray(conditions)
      ? conditions
      : (conditions && conditions.entries) || [];
    for (const entry of entries) {
      if (!entry || entry.type !== "resourceBalance") continue;
      if (entry.of != null && !EFFECT_RESOURCE_OWNERS.includes(entry.of)) {
        errors.push(
          where + ' asks about unknown owner "' + entry.of + '" (' + EFFECT_RESOURCE_OWNERS.join(", ") + ').'
        );
      }
      for (const message of validateResourceQuery(entry, where, Object.keys(resources))) {
        errors.push(message);
      }
    }
  };

  for (const id of Object.keys(abilities)) {
    const ability = abilities[id] || {};
    if (!ability.name) warnings.push(label("abilities", id) + " has no display name.");
    const targeting = ability.targeting || {};
    if (targeting.rangeMin != null && targeting.rangeMax != null && targeting.rangeMax < targeting.rangeMin) {
      errors.push(label("abilities", id) + " has a maximum range below its minimum.");
    }
    // Gating conditions on the ability itself: what makes it offered at all.
    checkEffectConditions(ability.conditions, label("abilities", id) + " availability");
    checkEffectRefs(ability.effects, id);

    /* ---- trajectory ----
     *
     * A route action's turn vocabulary and its price list are both authored,
     * so both can be authored wrong. Catching it here means the Studio refuses
     * the export rather than the player discovering it mid-charge. */
    const trajectory = ability.trajectory;
    if (trajectory) {
      if (trajectory.maxSegments != null && trajectory.maxSegments < 1) {
        errors.push(label("abilities", id) + " is a route action with no segments.");
      }
      if (trajectory.maxDistance != null && trajectory.maxDistance < 1) {
        errors.push(label("abilities", id) + " is a route action that cannot travel.");
      }
      if (trajectory.resourceId && !has(resources, trajectory.resourceId)) {
        errors.push(
          label("abilities", id) + ' prices its turns in unknown resource "' + trajectory.resourceId + '".'
        );
      }
      for (const category of trajectory.allowedRedirects || []) {
        if (!REDIRECT_IDS.includes(category)) {
          errors.push(label("abilities", id) + ' permits unknown turn category "' + category + '".');
        }
      }
      const priced = Object.keys(trajectory.redirectCosts || {});
      for (const category of priced) {
        if (!REDIRECT_IDS.includes(category)) {
          errors.push(label("abilities", id) + ' prices unknown turn category "' + category + '".');
        } else if (
          trajectory.allowedRedirects &&
          !trajectory.allowedRedirects.includes(category) &&
          category !== "straight"
        ) {
          warnings.push(
            label("abilities", id) + ' prices "' + category + '" turns but does not permit them.'
          );
        }
      }
      if (priced.length && !trajectory.resourceId) {
        errors.push(label("abilities", id) + " prices its turns but names no resource to pay with.");
      }
      checkEffectRefs(trajectory.contactEffects, id);
      for (const effect of trajectory.contactEffects || []) {
        if (effect && effect.type === "displace" && effect.distance != null && effect.distance < 0) {
          errors.push(label("abilities", id) + " displaces a negative distance on contact.");
        }
      }
    }

    /* ---- fixture targeting ----
     *
     * An ability that commands a device selects by tag, so the check is that
     * some fixture actually carries the tag — a detonator wired to a tag
     * nothing has is a button that is always greyed out. */
    const fixtureTargeting = ability.fixtureTargeting;
    if (fixtureTargeting) {
      if (fixtureTargeting.tag) {
        const carriers = Object.keys(fixtures).filter((fixtureId) =>
          ((fixtures[fixtureId] || {}).tags || []).includes(fixtureTargeting.tag)
        );
        if (!carriers.length) {
          errors.push(
            label("abilities", id) + ' commands fixtures tagged "' + fixtureTargeting.tag +
              '", which no fixture carries.'
          );
        }
      }
      for (const stateId of fixtureTargeting.states || []) {
        if (!FIXTURE_STATES.includes(stateId)) {
          errors.push(label("abilities", id) + ' targets unknown fixture state "' + stateId + '".');
        }
      }
      if (!["own", "team", "any"].includes(fixtureTargeting.ownership || "own")) {
        errors.push(
          label("abilities", id) + ' uses unknown fixture ownership "' + fixtureTargeting.ownership + '".'
        );
      }
      if (fixtureTargeting.rangeMax != null && fixtureTargeting.rangeMax < 0) {
        errors.push(label("abilities", id) + " commands fixtures at a negative range.");
      }
    }
    if (ability.fixtureAction && !["disarm", "arm", "remove"].includes(ability.fixtureAction)) {
      errors.push(label("abilities", id) + ' uses unknown fixture action "' + ability.fixtureAction + '".');
    }

    /* ---- propagation ----
     *
     * A chain is bounded by numbers an author types. Every one of them can be
     * typed wrong in a way that either does nothing or never stops, so both
     * ends are checked here rather than discovered mid-battle. */
    const propagation = ability.propagation;
    if (propagation) {
      if (propagation.maxHops != null && propagation.maxHops < 0) {
        errors.push(label("abilities", id) + " chains a negative number of times.");
      }
      if (propagation.maxHops != null && propagation.maxHops > MAX_PROPAGATION_HOPS) {
        warnings.push(
          label("abilities", id) + " asks for " + propagation.maxHops +
            " arcs; the engine caps chains at " + MAX_PROPAGATION_HOPS + "."
        );
      }
      if (propagation.hopRadius != null && propagation.hopRadius < 0) {
        errors.push(label("abilities", id) + " chains across a negative distance.");
      }
      if (propagation.hopRadius === 0) {
        warnings.push(label("abilities", id) + " has an arc range of zero and can never chain.");
      }
      if (propagation.selection && !SELECTION_POLICY_IDS.includes(propagation.selection)) {
        errors.push(
          label("abilities", id) + ' chooses targets by unknown policy "' + propagation.selection + '".'
        );
      }
      if (
        propagation.relationship &&
        !["enemy", "ally", "any", "self"].includes(propagation.relationship)
      ) {
        errors.push(
          label("abilities", id) + ' arcs to unknown relationship "' + propagation.relationship + '".'
        );
      }
      // Revisiting targets is legitimate for something like a bouncing heal,
      // but combined with arcing through the caster it is a two-node loop that
      // burns the whole hop budget on one pair. Worth saying out loud.
      if (propagation.allowRepeat && propagation.includeSource) {
        warnings.push(
          label("abilities", id) +
            " may revisit targets and arc through its own caster, which will bounce between two nodes."
        );
      }
      for (const filter of propagation.filters || []) {
        if (filter && filter.statusId && !has(statuses, filter.statusId)) {
          errors.push(
            label("abilities", id) + ' filters chain targets by unknown status "' + filter.statusId + '".'
          );
        }
      }
      const carries = (ability.effects || []).some((effect) => effect && effect.type === "propagate");
      if (!carries) {
        warnings.push(
          label("abilities", id) + " declares propagation but has no `propagate` effect to use it."
        );
      }
    }

    for (const resourceId of Object.keys(ability.costs || {})) {
      // A faction-scoped cost comes out of the squad's pool, so the unit
      // holding the ability is not expected to declare it. Checking a unit's
      // own dictionary for one made a squad-wide cost look unpayable.
      if ((resources[resourceId] || {}).scope === "faction") continue;
      const users = Object.keys(units).filter((unitId) => (units[unitId].abilities || []).includes(id));
      const unmet = users.filter((unitId) => !((units[unitId].resources || {})[resourceId]));
      if (users.length && unmet.length === users.length) {
        errors.push(
          label("abilities", id) + ' costs "' + resourceId + '" but no unit that has it carries that resource.'
        );
      }
    }

    /* ---- resource transfer ----
     *
     * A transfer is two resource ids and three numbers, so every way of
     * authoring it wrong is silent: it simply moves nothing, forever, and the
     * only symptom is a support operator who appears to do nothing. */
    for (const effect of ability.effects || []) {
      if (effect.type !== "transferResource") continue;
      const source = effect.resourceId;
      const destination = effect.intoResourceId || effect.resourceId;
      const sourceDefinition = resources[source];
      const destinationDefinition = resources[destination];

      if (!source) errors.push(label("abilities", id) + " transfers with no source resource.");
      else if (!sourceDefinition) {
        errors.push(label("abilities", id) + ' transfers unknown resource "' + source + '".');
      }
      if (!destinationDefinition) {
        errors.push(label("abilities", id) + ' transfers into unknown resource "' + destination + '".');
      }
      for (const key of ["from", "to"]) {
        if (effect[key] && !["source", "target"].includes(effect[key])) {
          errors.push(label("abilities", id) + " transfers " + key + ' an unknown side "' + effect[key] + '".');
        }
      }
      for (const key of ["cost", "gain", "maxTransfers"]) {
        if (effect[key] == null) continue;
        if (!Number.isFinite(effect[key]) || effect[key] < 1) {
          errors.push(label("abilities", id) + " needs a positive whole " + key + ".");
        }
      }
      // Same resource, same side: the points would come straight back.
      if (source === destination && (effect.from || "source") === (effect.to || "target")) {
        errors.push(
          label("abilities", id) + " transfers a resource to the balance it came from, which does nothing."
        );
      }
      if (sourceDefinition && destinationDefinition) {
        // A faction resource has one balance for the whole side, so "from the
        // source's pool to the target's pool" is the same pool twice.
        const bothFaction =
          sourceDefinition.scope === "faction" && destinationDefinition.scope === "faction";
        if (bothFaction && source === destination) {
          errors.push(
            label("abilities", id) +
              " transfers a shared resource into itself, which is one pool twice."
          );
        }
      }
      const cost = effect.cost == null ? 1 : effect.cost;
      const gain = effect.gain == null ? cost : effect.gain;
      if (destinationDefinition && destinationDefinition.max != null && gain > destinationDefinition.max) {
        errors.push(
          label("abilities", id) + " delivers " + gain + ' "' + destination +
            '" at a time, more than the resource can ever hold.'
        );
      }
      if (sourceDefinition && sourceDefinition.max != null && cost > sourceDefinition.max) {
        errors.push(
          label("abilities", id) + " costs " + cost + ' "' + source +
            '" per transfer, more than the resource can ever hold.'
        );
      }
    }

    /* ---- activation window ----
     *
     * A command that sequences turns is authored entirely as numbers, so it
     * can be authored into uselessness in several quiet ways. Each of these
     * produces an ability that appears, costs its resource and then does
     * nothing a player could notice. */
    const window = ability.activationWindow;
    if (window) {
      if (window.lookahead != null && !(window.lookahead > 0)) {
        errors.push(label("abilities", id) + " commands a window that reaches no further than now.");
      }
      if (window.maxUnits != null && window.maxUnits < 2) {
        errors.push(
          label("abilities", id) +
            " can sequence fewer than two activations, so there is no order to change."
        );
      }
      if (window.relationship && !WINDOW_RELATIONSHIPS.includes(window.relationship)) {
        errors.push(
          label("abilities", id) + ' commands unknown relationship "' + window.relationship +
            '". Available: ' + WINDOW_RELATIONSHIPS.join(", ")
        );
      }
      if (window.hostileBarrier && !HOSTILE_BARRIER_MODES.includes(window.hostileBarrier)) {
        errors.push(
          label("abilities", id) + ' uses unknown hostile-barrier mode "' + window.hostileBarrier +
            '". Available: ' + HOSTILE_BARRIER_MODES.join(", ")
        );
      }
      if (window.includeActive && window.maxUnits === 1) {
        errors.push(
          label("abilities", id) + " can only sequence the unit already acting, which changes nothing."
        );
      }
      if ((ability.effects || []).length) {
        warnings.push(
          label("abilities", id) +
            " is a sequencing command with ordinary effects; those never run, because it is not issued as one."
        );
      }
    }
  }

  /* ---- fixtures ----
   *
   * A fixture is a thing an author can leave on the map for the rest of a
   * battle. Every way of authoring one wrong ends with either a device that
   * does nothing or one that cannot be cleared, and both are worse than an
   * export that refuses. */
  for (const id of Object.keys(fixtures)) {
    const fixture = fixtures[id] || {};
    if (!fixture.name) warnings.push(label("fixtures", id) + " has no display name.");

    if (fixture.visibility && !FIXTURE_VISIBILITY.includes(fixture.visibility)) {
      errors.push(label("fixtures", id) + ' has unknown visibility "' + fixture.visibility + '".');
    }
    if (fixture.initialState && !FIXTURE_STATES.includes(fixture.initialState)) {
      errors.push(label("fixtures", id) + ' starts in unknown state "' + fixture.initialState + '".');
    }
    if (fixture.initialState === "removed" || fixture.initialState === "triggered") {
      errors.push(label("fixtures", id) + " starts in a state it can never act from.");
    }
    if (fixture.charges != null && fixture.charges < 0) {
      errors.push(label("fixtures", id) + " has a negative number of charges.");
    }
    if (fixture.charges === 0) {
      warnings.push(label("fixtures", id) + " has no charges and can never activate.");
    }

    const trigger = fixture.trigger || {};
    if (!FIXTURE_TRIGGER_TYPES.includes(trigger.type)) {
      errors.push(label("fixtures", id) + ' has unknown trigger type "' + trigger.type + '".');
    }
    if (trigger.triggeredBy && !["enemy", "ally", "any"].includes(trigger.triggeredBy)) {
      errors.push(
        label("fixtures", id) + ' triggers on unknown relationship "' + trigger.triggeredBy + '".'
      );
    }
    // A device that goes off under its own owner and then damages its own
    // side is authorable, but it is almost never what someone meant.
    if (trigger.includesOwner && fixture.affects === "ally") {
      warnings.push(
        label("fixtures", id) + " triggers under its owner and affects allies, which will hit the owner."
      );
    }
    if (fixture.affects && !["enemy", "ally", "any"].includes(fixture.affects)) {
      errors.push(label("fixtures", id) + ' affects unknown relationship "' + fixture.affects + '".');
    }
    if (!(fixture.effects || []).length) {
      warnings.push(label("fixtures", id) + " does nothing when it activates.");
    }
    // A blocking fixture placed on the tile the placer is standing on would
    // trap them; a blocking fixture that is also invisible to its enemies is
    // an invisible wall. Neither is a thing anybody wants shipped.
    if (fixture.blocksMovement && fixture.visibility !== "everyone") {
      errors.push(
        label("fixtures", id) + " blocks movement but is not visible to everyone, which is an invisible wall."
      );
    }
    checkEffectRefs(fixture.effects, id);
    for (const effect of fixture.effects || []) {
      // The obvious way to write a device that sets itself off forever.
      if (effect && effect.type === "placeFixture" && effect.definitionId === id) {
        errors.push(label("fixtures", id) + " places itself, which would never stop.");
      }
    }
  }

  /* ---- equipment ---- */
  for (const id of Object.keys(equipment)) {
    const item = equipment[id] || {};
    if (!item.name) warnings.push(label("equipment", id) + " has no display name.");
    if (!EQUIPMENT_SLOTS.includes(item.slot)) {
      errors.push(label("equipment", id) + ' has unknown slot "' + item.slot + '".');
    }
    for (const abilityId of (item.grantsAbilities || []).concat(item.removesAbilities || [])) {
      if (!has(abilities, abilityId)) {
        errors.push(label("equipment", id) + ' references unknown ability "' + abilityId + '".');
      }
    }
    for (const modifier of item.modifiers || []) {
      if (!modifier || !modifier.stat) {
        errors.push(label("equipment", id) + " has a modifier with no stat.");
      } else if (!Number.isFinite(Number(modifier.value))) {
        errors.push(label("equipment", id) + ' has a non-numeric modifier on "' + modifier.stat + '".');
      }
    }
    const classes = item.compatibleClasses || [];
    if (classes.length) {
      const known = new Set(Object.keys(units).map((unitId) => units[unitId].classId).filter(Boolean));
      for (const className of classes) {
        if (!known.has(className)) {
          warnings.push(
            label("equipment", id) + ' is restricted to class "' + className + '", which no unit has.'
          );
        }
      }
    }
    validatePerception(item.perception, label("equipment", id), errors);
  }

  /* ---- statuses ---- */
  for (const id of Object.keys(statuses)) {
    const status = statuses[id] || {};
    if (!status.name) warnings.push(label("statuses", id) + " has no display name.");
    const duration = status.duration || {};
    if (duration.amount != null && !(Number(duration.amount) > 0)) {
      errors.push(label("statuses", id) + " has a duration that is not positive.");
    }
    validatePerception(status.perception, label("statuses", id), errors);

    /* ---- triggers ----
     *
     * A trigger naming a moment the engine never fires is invisible: the
     * status exists, the effects are authored, and nothing ever happens. That
     * failure mode is indistinguishable from a balance problem from the
     * outside, which is why an unknown moment is an error rather than a
     * warning. */
    (status.triggers || []).forEach((trigger, index) => {
      const where = label("statuses", id) + " trigger " + (index + 1);
      if (!trigger || typeof trigger !== "object") {
        errors.push(where + " is not an object.");
        return;
      }
      if (!STATUS_TRIGGER_EVENT_IDS.includes(trigger.event)) {
        errors.push(
          where + ' fires on unknown moment "' + trigger.event + '" (' +
            STATUS_TRIGGER_EVENT_IDS.join(", ") + ').'
        );
      }
      if (trigger.target != null && !STATUS_TRIGGER_TARGETS.includes(trigger.target)) {
        errors.push(
          where + ' lands on unknown target "' + trigger.target + '" (' +
            STATUS_TRIGGER_TARGETS.join(", ") + ').'
        );
      }
      // A counterpart trigger at a moment with nobody on the other side is a
      // trigger that silently never runs.
      if (trigger.target === "counterpart" && !statusTriggerHasCounterpart(trigger.event)) {
        errors.push(
          where + ' lands on a counterpart, but "' + trigger.event + '" has no second party.'
        );
      }
      if (!Array.isArray(trigger.effects) || !trigger.effects.length) {
        errors.push(where + " has no effects, so it does nothing.");
      }
      checkEffectRefs(trigger.effects, id, 0, "statuses");
      // The one self-recursion that is statically obvious: a status that
      // reapplies itself the instant it lands. The causal chain would bound it
      // at runtime, but authoring it is never what anybody meant.
      if (trigger.event === "statusApplied" && trigger.target !== "counterpart") {
        for (const effect of trigger.effects || []) {
          if (effect && effect.type === "applyStatus" && effect.statusId === id) {
            errors.push(
              where + " reapplies its own status the moment it lands, which is a loop."
            );
          }
        }
      }
    });
  }

  /* ---- operators and perks ---- */
  const seenRefs = {};
  for (const id of Object.keys(operators)) {
    const operator = operators[id] || {};
    if (!operator.chassis) {
      errors.push(label("operators", id) + " has no chassis.");
    } else if (!has(units, operator.chassis)) {
      errors.push(label("operators", id) + ' references unknown chassis "' + operator.chassis + '".');
    }
    for (const perkId of operator.perkChoices || []) {
      if (!has(perks, perkId)) {
        errors.push(label("operators", id) + ' offers unknown perk "' + perkId + '".');
      }
    }
    // An operator's entry id is its one canonical name. A leftover `ref` is
    // the second identifier this project deliberately removed, so it is an
    // error even when it agrees with the key — agreeing today is exactly how
    // the last one survived long enough to disagree later.
    if (operator.ref !== undefined) {
      errors.push(
        label("operators", id) + ' still carries a legacy "ref" field. An operator is ' +
          'addressed by its entry id everywhere; delete the ref.'
      );
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
      errors.push(label("operators", id) + " needs a stable slug id.");
    }
    if (seenRefs[id.toLowerCase()]) {
      errors.push(
        label("operators", id) + ' collides with operator "' + seenRefs[id.toLowerCase()] +
          '" — two operators cannot share an id.'
      );
    }
    seenRefs[id.toLowerCase()] = id;
  }

  /* ---- outside references ---- */
  for (const definitionId of external.missionUnitDefinitionIds || []) {
    if (!has(units, definitionId)) {
      errors.push('A mission places unit "' + definitionId + '", which no longer exists.');
    }
  }
  for (const equipmentId of external.missionEquipmentIds || []) {
    if (!has(equipment, equipmentId)) {
      errors.push('A mission equips "' + equipmentId + '", which no longer exists.');
    }
  }
  for (const ref of external.linkParticipantRefs || []) {
    if (!has(operators, ref)) {
      warnings.push('A combat link names "' + ref + '", which is not an operator id.');
    }
  }
  for (const statusId of external.reactionStatusIds || []) {
    if (!has(statuses, statusId)) {
      errors.push('A reaction applies status "' + statusId + '", which no longer exists.');
    }
  }

  /* ---- resources ---- */
  for (const id of Object.keys(resources)) {
    const definition = { id, ...resources[id] };
    for (const message of validateResourceDefinition(definition, label("resources", id))) {
      errors.push(message);
    }
    if (definition.linkId && !has(combatLinks, definition.linkId)) {
      errors.push(
        label("resources", id) + ' is gated by unknown combat link "' + definition.linkId + '".'
      );
    }
    if (definition.scope === "faction" && definition.everyUnit) {
      errors.push(
        label("resources", id) + " is faction-scoped, so `everyUnit` means nothing — remove it."
      );
    }
  }

  /* ---- status-driven impairment ----
   *
   * A status that takes a capability away is this project's whole subsystem
   * model, so the references in it are worth checking: an id typo produces a
   * status that reads as damage and removes nothing. */
  for (const id of Object.keys(statuses)) {
    const status = statuses[id] || {};
    for (const abilityId of status.removesAbilities || []) {
      if (!has(abilities, abilityId)) {
        errors.push(label("statuses", id) + ' takes unknown ability "' + abilityId + '" offline.');
      }
    }
    const tags = status.blocksAbilityTags || [];
    for (const tag of tags) {
      const carried = Object.keys(abilities).some((abilityId) =>
        (((abilities[abilityId] || {}).ui || {}).tags || []).includes(tag)
      );
      if (!carried) {
        errors.push(
          label("statuses", id) + ' blocks ability tag "' + tag + '", which no ability carries.'
        );
      }
    }
  }

  /* ---- reactions ---- */
  for (const id of Object.keys(reactions)) {
    const reaction = reactions[id] || {};
    if (!reaction.name) warnings.push(label("reactions", id) + " has no display name.");

    if (!reaction.trigger) {
      errors.push(label("reactions", id) + " has no trigger event.");
    } else if (!REACTION_EVENT_TYPE_IDS.includes(reaction.trigger)) {
      errors.push(
        label("reactions", id) + ' triggers on unknown event "' + reaction.trigger +
          '". Available: ' + REACTION_EVENT_TYPE_IDS.join(", ")
      );
    }

    // An owned reaction names an operator by its stable ref, not by its key.
    if (reaction.owner) {
      const owned = Object.keys(operators).some(
        (operatorId) => operatorId === reaction.owner
      );
      if (!owned && !(external.unitRefs || []).includes(reaction.owner)) {
        errors.push(label("reactions", id) + ' is owned by unknown operator "' + reaction.owner + '".');
      }
    } else if (!reaction.requires) {
      errors.push(
        label("reactions", id) +
          " has no owner and no `requires`, so nothing would ever be offered it."
      );
    }

    if (reaction.requires && reaction.requires.status && !has(statuses, reaction.requires.status)) {
      errors.push(
        label("reactions", id) + ' requires unknown status "' + reaction.requires.status + '".'
      );
    }

    for (const message of validateReactionCondition(
      reaction.conditions,
      label("reactions", id) + " condition",
      Object.keys(resources)
    )) {
      errors.push(message);
    }

    for (const entry of (reaction.cost && reaction.cost.resources) || []) {
      if (!has(resources, entry.id)) {
        errors.push(label("reactions", id) + ' costs unknown resource "' + entry.id + '".');
        continue;
      }
      const amount = Number(entry.amount == null ? 1 : entry.amount);
      const max = Number((resources[entry.id] || {}).max || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        errors.push(label("reactions", id) + " costs a non-positive amount of " + entry.id + ".");
      } else if (max && amount > max) {
        errors.push(
          label("reactions", id) + " costs " + amount + " " + entry.id +
            ", more than the resource's maximum of " + max + " — it could never be paid."
        );
      }
    }

    if (!reaction.effect) {
      errors.push(label("reactions", id) + " has no effect, so firing it would do nothing.");
    } else {
      for (const message of validateReactionEffect(reaction.effect, label("reactions", id) + " effect")) {
        errors.push(message);
      }
      const effect = reaction.effect;
      if (effect.statusId && !has(statuses, effect.statusId)) {
        errors.push(label("reactions", id) + ' applies unknown status "' + effect.statusId + '".');
      }
      if (effect.abilityId && !has(abilities, effect.abilityId)) {
        errors.push(label("reactions", id) + ' uses unknown ability "' + effect.abilityId + '".');
      }
      if (effect.resourceId && !has(resources, effect.resourceId)) {
        errors.push(label("reactions", id) + ' restores unknown resource "' + effect.resourceId + '".');
      }

      /* Interventions are only meaningful before their action resolves.
       *
       * These are the failure modes that would otherwise be silent. A cancel
       * hung on `unitDestroyed` never has an action to cancel and simply does
       * nothing forever; the author's only clue would be that their duelist
       * never fires. The runtime cannot warn about it, because from the
       * runtime's point of view a reaction whose effect returns `ok: false` is
       * behaving normally. */
      if (INTERVENTION_EFFECT_TYPES.includes(effect.type)) {
        if (reaction.trigger !== "actionDeclared") {
          errors.push(
            label("reactions", id) + " uses " + effect.type + ' but triggers on "' +
              reaction.trigger + '". An action can only be changed before it resolves, ' +
              'so an intervention must trigger on "actionDeclared".'
          );
        }
        if (!reaction.mandatory && !(reaction.cost && (reaction.cost.resources || []).length)) {
          warnings.push(
            label("reactions", id) +
              " changes what an enemy is allowed to do and costs nothing, so nothing limits how often."
          );
        }
        const limits = reaction.limits || {};
        if (limits.perActivation == null && limits.perChain == null && limits.perEvent == null) {
          warnings.push(
            label("reactions", id) + " is an intervention with no per-activation or per-chain limit."
          );
        }
      }
      /* The counterpart mistake: answering a prevention that can never occur
       * for the reactor, because it triggers somewhere the reason is unknown. */
      if (reaction.trigger === "actionPrevented" && effect.type === "cancelTriggeringAction") {
        errors.push(
          label("reactions", id) +
            " cancels an action that has already been prevented, which is nothing to cancel."
        );
      }
    }

    for (const key of Object.keys(reaction.limits || {})) {
      if (key === "perEvent") continue;
      const value = reaction.limits[key];
      if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 1)) {
        errors.push(label("reactions", id) + " has a " + key + " limit below 1, which disables it entirely.");
      }
    }
  }

  /* ---- combat links ---- */
  for (const id of Object.keys(combatLinks)) {
    const link = combatLinks[id] || {};
    if (!link.name) warnings.push(label("combatLinks", id) + " has no display name.");
    if (!(link.participants || []).length) {
      errors.push(label("combatLinks", id) + " has no participants, so it can never be active.");
    }
    for (const ref of link.participants || []) {
      const known = Object.keys(operators).some(
        (operatorId) => operatorId === ref
      );
      if (!known) {
        errors.push(label("combatLinks", id) + ' names unknown operator "' + ref + '".');
      }
    }
    for (const reactionId of link.reactions || []) {
      if (!has(reactions, reactionId)) {
        errors.push(label("combatLinks", id) + ' grants unknown reaction "' + reactionId + '".');
      }
    }
    // A reaction may belong to at most one link: two owners would make
    // "is this available?" ambiguous.
    for (const reactionId of link.reactions || []) {
      const owners = Object.keys(combatLinks).filter((otherId) =>
        ((combatLinks[otherId] || {}).reactions || []).includes(reactionId)
      );
      if (owners.length > 1) {
        errors.push(
          'Reaction "' + reactionId + '" is granted by more than one link (' + owners.join(", ") + ")."
        );
      }
    }
  }

  /* ---- terrain ----
   * The map editor paints by character, so two terrain types answering to the
   * same character would make an exported map ambiguous — which is a data
   * error, not a taste question. */
  const charOwners = {};
  for (const id of Object.keys(terrain)) {
    const tile = terrain[id] || {};
    if (!tile.name) warnings.push(label("terrain", id) + " has no display name.");

    const character = tile.char;
    if (!character) {
      errors.push(label("terrain", id) + " has no map character, so a map cannot be written with it.");
    } else if (String(character).length !== 1) {
      errors.push(label("terrain", id) + ' has map character "' + character + '"; it must be exactly one character.');
    } else if (charOwners[character]) {
      errors.push(
        label("terrain", id) + ' uses map character "' + character + '", already taken by "' +
          charOwners[character] + '".'
      );
    } else {
      charOwners[character] = id;
    }

    if (tile.paint != null && !/^#[0-9a-fA-F]{3,8}$/.test(String(tile.paint))) {
      errors.push(label("terrain", id) + ' has swatch colour "' + tile.paint + '", which is not a hex colour.');
    }

    if (tile.walkable === false) {
      if (tile.movementCost != null) {
        errors.push(
          label("terrain", id) + " cannot be entered, so it must not carry a movement cost."
        );
      }
    } else if (!Number.isFinite(Number(tile.movementCost)) || Number(tile.movementCost) < 1) {
      errors.push(label("terrain", id) + " needs a movement cost of at least 1.");
    }

    for (const key of Object.keys(tile.modifiers || {})) {
      if (!/(Flat|Multiplier)$/.test(key)) {
        errors.push(
          label("terrain", id) + ' has modifier "' + key + '"; keys end in Flat or Multiplier.'
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validatePerception(perception, prefix, errors) {
  if (!perception) return;
  for (const group of ["sensors", "emissions"]) {
    const map = perception[group];
    if (!map) continue;
    for (const channel of Object.keys(map)) {
      if (!CHANNELS.includes(channel)) {
        errors.push(prefix + ' has ' + group + ' on unknown channel "' + channel + '".');
      }
      const value = group === "sensors" ? (map[channel] || {}).range : map[channel];
      if (value != null && !Number.isFinite(Number(value))) {
        errors.push(prefix + " has a non-numeric " + group + " value on " + channel + ".");
      }
    }
  }
}

/**
 * Everything that would break if an entity disappeared.
 *
 * Used before a delete or a rename, so the answer is "these three things point
 * at it" rather than a broken build later.
 */
export function referencesTo(data, kindId, id, context) {
  const registries = {};
  for (const kind of REGISTRY_IDS) registries[kind] = (data && data[kind]) || {};
  const external = context || {};
  const found = [];

  const note = (where, why) => found.push({ where, why });

  if (kindId === "abilities") {
    for (const unitId of Object.keys(registries.units)) {
      const unit = registries.units[unitId];
      if ((unit.abilities || []).includes(id)) note("unit " + unitId, "grants it");
      if (unit.defaultAbilityId === id) note("unit " + unitId, "uses it by default");
    }
    for (const equipmentId of Object.keys(registries.equipment)) {
      const item = registries.equipment[equipmentId];
      if ((item.grantsAbilities || []).includes(id)) note("equipment " + equipmentId, "grants it");
      if ((item.removesAbilities || []).includes(id)) note("equipment " + equipmentId, "removes it");
    }
  }

  if (kindId === "units") {
    for (const operatorId of Object.keys(registries.operators)) {
      if (registries.operators[operatorId].chassis === id) note("operator " + operatorId, "pilots it");
    }
    for (const abilityId of Object.keys(registries.abilities)) {
      for (const effect of registries.abilities[abilityId].effects || []) {
        if (effect && effect.definitionId === id) note("ability " + abilityId, "summons it");
      }
    }
    for (const missionId of Object.keys(external.missionUnitUsage || {})) {
      if ((external.missionUnitUsage[missionId] || []).includes(id)) note("mission " + missionId, "places it");
    }
  }

  if (kindId === "equipment") {
    for (const unitId of Object.keys(registries.units)) {
      const defaults = registries.units[unitId].defaultEquipment || {};
      if (Object.values(defaults).includes(id)) note("unit " + unitId, "fields it by default");
    }
    for (const missionId of Object.keys(external.missionEquipmentUsage || {})) {
      if ((external.missionEquipmentUsage[missionId] || []).includes(id)) note("mission " + missionId, "equips it");
    }
  }

  if (kindId === "statuses") {
    for (const abilityId of Object.keys(registries.abilities)) {
      for (const effect of registries.abilities[abilityId].effects || []) {
        if (effect && effect.statusId === id) note("ability " + abilityId, "applies it");
      }
    }
    for (const statusId of Object.keys(registries.statuses)) {
      for (const trigger of registries.statuses[statusId].triggers || []) {
        if (trigger && trigger.statusId === id) note("status " + statusId, "triggers it");
      }
    }
  }

  if (kindId === "aiProfiles") {
    for (const unitId of Object.keys(registries.units)) {
      if (registries.units[unitId].aiProfile === id) note("unit " + unitId, "uses it");
    }
  }

  if (kindId === "perks") {
    for (const operatorId of Object.keys(registries.operators)) {
      if ((registries.operators[operatorId].perkChoices || []).includes(id)) {
        note("operator " + operatorId, "offers it");
      }
    }
  }

  if (kindId === "operators") {
    for (const ref of external.linkParticipantRefs || []) {
      const operator = registries.operators[id] || {};
      if (id === ref) note("a combat link", "names it");
    }
  }

  return found;
}
