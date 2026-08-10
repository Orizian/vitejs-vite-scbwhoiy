/* =========================================================================
 * GAMEPLAY DATA REGISTRY
 *
 * Loads the canonical gameplay files and, when one is present, overlays the
 * Studio's draft on top.
 *
 * The draft overlay is what makes `Test Unit` honest. The engine's CONTENT
 * registry is built once at import and frozen — that is a property worth
 * keeping — so testing an unsaved change means the change has to be in place
 * *before* the registry is built. A draft in storage plus a reload does that
 * exactly, and the battle then runs on the real engine reading real content,
 * with no editor-only path through the simulation.
 *
 * Shaped like `mission-registry.js` and `scene-registry.js` on purpose:
 * canonical files, an editor slot, one merge, no second source of truth.
 * =======================================================================*/

import { REGISTRY_IDS, REGISTRY_KINDS, parseRegistryFile } from "./format.js";

import units from "./units.json";
import abilities from "./abilities.json";
import statuses from "./statuses.json";
import equipment from "./equipment.json";
import aiProfiles from "./ai-profiles.json";
import operators from "./operators.json";
import perks from "./perks.json";

export const GAMEPLAY_DRAFT_STORAGE_KEY = "statuszero.gameplay.draft";

const CANONICAL_FILES = {
  units,
  abilities,
  statuses,
  equipment,
  aiProfiles,
  operators,
  perks
};

/** The data exactly as it ships, before any draft. */
export const CANONICAL_GAMEPLAY = (() => {
  const out = {};
  for (const kindId of REGISTRY_IDS) {
    out[kindId] = parseRegistryFile(CANONICAL_FILES[kindId]).entries;
  }
  return out;
})();

function readDraft() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(GAMEPLAY_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGameplayDraft(draft) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(GAMEPLAY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearGameplayDraft() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(GAMEPLAY_DRAFT_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function readGameplayDraft() {
  return readDraft();
}

/**
 * Canonical data with the draft applied.
 *
 * The overlay is per entity, not per file: a draft that changes one unit does
 * not have to restate the other nineteen, and an entity the draft deletes is
 * removed rather than left behind.
 */
function applyDraft(canonical, draft) {
  if (!draft || !draft.registries) return { data: canonical, active: false, counts: {} };
  const data = {};
  const counts = {};
  for (const kindId of REGISTRY_IDS) {
    const base = { ...canonical[kindId] };
    const patch = draft.registries[kindId] || {};
    let changed = 0;
    for (const id of Object.keys(patch)) {
      if (patch[id] === null) {
        delete base[id];
        changed += 1;
        continue;
      }
      base[id] = patch[id];
      changed += 1;
    }
    if (changed) counts[kindId] = changed;
    data[kindId] = base;
  }
  return { data, active: Object.keys(counts).length > 0, counts };
}

const applied = applyDraft(CANONICAL_GAMEPLAY, readDraft());

/** What the game actually runs on. */
export const GAMEPLAY_CONTENT = applied.data;

/** True while a Studio draft is shaping the running content. */
export const GAMEPLAY_DRAFT_ACTIVE = applied.active;
export const GAMEPLAY_DRAFT_COUNTS = applied.counts;

export function canonicalEntries(kindId) {
  return CANONICAL_GAMEPLAY[kindId] || {};
}

export function gameplayEntries(kindId) {
  return GAMEPLAY_CONTENT[kindId] || {};
}

export function gameplayEntity(kindId, id) {
  const entries = GAMEPLAY_CONTENT[kindId];
  return (entries && entries[id]) || null;
}

export { REGISTRY_IDS, REGISTRY_KINDS };
