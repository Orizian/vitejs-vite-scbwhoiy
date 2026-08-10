/* =========================================================================
 * LEGACY SCENE ADAPTER
 *
 * Mission files and the built-in campaign already carry narrative content, in
 * an older shape: a scene is a title, a location and a flat list of
 * `{ speaker, text }` lines, with optional choices at the end.
 *
 * That format is a strict subset of the step format — every line is a
 * `dialogue` step, the location is a `background` step, and the end is an
 * `end` step. So it does not need a second runtime; it needs this function.
 *
 * Direction is deliberate and one-way. New authoring produces steps. Existing
 * content is lifted into steps on read. Nothing converts steps back into
 * lines, because that would lose everything the older format cannot say.
 *
 * What does not survive the lift: `choices`. Branching is explicitly out of
 * scope for this phase, so a legacy scene with choices keeps being played by
 * the legacy sequence screen. `legacySceneIsConvertible` says which is which.
 * =======================================================================*/

import { normalizeScene } from "./format.js";

/**
 * @param legacy  { title, location, kind, lines: [{speaker, text}], choices }
 * @param sceneId stable id for the resulting scene
 */
export function sceneFromLegacy(legacy, sceneId) {
  const source = legacy && typeof legacy === "object" ? legacy : {};
  const lines = Array.isArray(source.lines) ? source.lines : [];
  const steps = [];

  if (source.location) {
    steps.push({
      type: "background",
      background: slugify(source.location),
      label: source.location
    });
  }

  // The older format has no staging, so a speaker simply is on stage when
  // they talk. The dialogue step already means that, which is why the lift
  // needs no synthetic enter/exit steps.
  for (const line of lines) {
    steps.push({
      type: "dialogue",
      speaker: line.speaker || "narrator",
      text: line.text || ""
    });
  }

  steps.push({ type: "end" });

  return normalizeScene({
    id: sceneId || source.sceneId || "legacy-scene",
    name: source.title || sceneId || "Legacy scene",
    description: source.location ? "Adapted from a lines-based scene at " + source.location + "." : "",
    steps
  });
}

/** False when the older scene uses something steps cannot yet express. */
export function legacySceneIsConvertible(legacy) {
  const source = legacy && typeof legacy === "object" ? legacy : {};
  if (Array.isArray(source.choices) && source.choices.length) return false;
  return Array.isArray(source.lines) && source.lines.length > 0;
}

/** Why a scene was left on the legacy path, for the migration report. */
export function legacySceneBlocker(legacy) {
  const source = legacy && typeof legacy === "object" ? legacy : {};
  if (Array.isArray(source.choices) && source.choices.length) return "uses branching choices";
  if (!Array.isArray(source.lines) || !source.lines.length) return "has no lines";
  return null;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export { slugify as slugifyLocation };
