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
import { validateResourceDefinition } from "../../combat/resources.js";
import { REACTION_EVENT_TYPE_IDS } from "../../reactions/events.js";
import { validateReactionEffect } from "../../reactions/effects.js";
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
    resources, reactions, combatLinks
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
  for (const id of Object.keys(abilities)) {
    const ability = abilities[id] || {};
    if (!ability.name) warnings.push(label("abilities", id) + " has no display name.");
    const targeting = ability.targeting || {};
    if (targeting.rangeMin != null && targeting.rangeMax != null && targeting.rangeMax < targeting.rangeMin) {
      errors.push(label("abilities", id) + " has a maximum range below its minimum.");
    }
    for (const effect of ability.effects || []) {
      if (effect && effect.statusId && !has(statuses, effect.statusId)) {
        errors.push(label("abilities", id) + ' applies unknown status "' + effect.statusId + '".');
      }
      if (effect && effect.abilityId && !has(abilities, effect.abilityId)) {
        errors.push(label("abilities", id) + ' references unknown ability "' + effect.abilityId + '".');
      }
      if (effect && effect.definitionId && !has(units, effect.definitionId)) {
        errors.push(label("abilities", id) + ' summons unknown unit "' + effect.definitionId + '".');
      }
    }
    for (const resourceId of Object.keys(ability.costs || {})) {
      const users = Object.keys(units).filter((unitId) => (units[unitId].abilities || []).includes(id));
      const unmet = users.filter((unitId) => !((units[unitId].resources || {})[resourceId]));
      if (users.length && unmet.length === users.length) {
        errors.push(
          label("abilities", id) + ' costs "' + resourceId + '" but no unit that has it carries that resource.'
        );
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
    // The stable ref is what links, reactions and mission scripts address, so
    // two operators answering to one ref is a silent aliasing bug.
    const ref = operator.ref || id;
    if (seenRefs[ref]) {
      errors.push(
        label("operators", id) + ' shares stable ref "' + ref + '" with operator "' + seenRefs[ref] + '".'
      );
    }
    seenRefs[ref] = id;
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
    if (!Object.values(operators).some((operator) => (operator.ref || "") === ref)) {
      warnings.push('A combat link names "' + ref + '", which is not an operator ref.');
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
        (operatorId) => (operators[operatorId].ref || operatorId) === reaction.owner
      );
      if (!owned && !(external.unitRefs || []).includes(reaction.owner)) {
        errors.push(label("reactions", id) + ' is owned by unknown operator ref "' + reaction.owner + '".');
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

    for (const message of validateReactionCondition(reaction.conditions, label("reactions", id) + " condition")) {
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
        (operatorId) => (operators[operatorId].ref || operatorId) === ref
      );
      if (!known) {
        errors.push(label("combatLinks", id) + ' names unknown operator ref "' + ref + '".');
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
      if ((operator.ref || id) === ref) note("a combat link", "names its ref");
    }
  }

  return found;
}
