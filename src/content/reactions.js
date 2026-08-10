/* =========================================================================
 * REACTION AND LINK CONTENT
 *
 * Reactions, combat links and resources are authored in
 * `src/content/gameplay/*.json` alongside every other gameplay registry, and
 * edited in the Gameplay Data Studio. This module is the adapter that turns
 * those id-keyed maps into the ordered lists the reaction runtime wants.
 *
 * It holds no data of its own. Adding a reaction is a data edit; nothing in
 * `src/reactions/`, `src/combat/` or App.jsx knows any of these ids exist.
 * =======================================================================*/

import { GAMEPLAY_CONTENT } from "./gameplay/registry.js";

/** Id-keyed registry → the list form the runtime indexes, in stable id order. */
function asList(entries) {
  return Object.keys(entries || {})
    .sort()
    .map((id) => ({ id, ...entries[id] }));
}

export const REACTION_DEFINITIONS = asList(GAMEPLAY_CONTENT.reactions);
export const LINK_DEFINITIONS = asList(GAMEPLAY_CONTENT.combatLinks);
export const RESOURCE_DEFINITIONS = asList(GAMEPLAY_CONTENT.resources);

export const REACTION_CONTENT = {
  reactions: REACTION_DEFINITIONS,
  links: LINK_DEFINITIONS,
  resources: RESOURCE_DEFINITIONS
};

export function reactionDefinitionById(id) {
  return REACTION_DEFINITIONS.find((entry) => entry.id === id) || null;
}

export function linkDefinitionById(id) {
  return LINK_DEFINITIONS.find((entry) => entry.id === id) || null;
}

export function resourceDefinitionById(id) {
  return RESOURCE_DEFINITIONS.find((entry) => entry.id === id) || null;
}

export const LINK_IDS = LINK_DEFINITIONS.map((entry) => entry.id);
export const RESOURCE_IDS = RESOURCE_DEFINITIONS.map((entry) => entry.id);
