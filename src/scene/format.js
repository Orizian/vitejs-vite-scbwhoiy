/* =========================================================================
 * STATUS ZERO — SCENE FORMAT
 *
 * One scene = one JSON file = an ordered list of steps. The same document is
 * what the editor edits, what `serializeScene` writes to disk, and what the
 * player runs. There is no editor-side representation and no runtime-side
 * representation; there is the scene.
 *
 * Three jobs, mirroring `mission-format.js` so the two feel like one tool:
 *
 *   normalizeScene()  fills defaults, tolerates older files
 *   validateScene()   errors (won't ship) and warnings (will, read them)
 *   serializeScene()  deterministic, reviewable JSON
 *
 * A scene needs no battle, no map and no mission. That is the point: a base
 * conversation, a flashback and an act transition are all just scenes.
 * =======================================================================*/

import { SCENE_STEP_TYPES, sceneStepType, createStage } from "./steps.js";

export const SCENE_FORMAT_ID = "statuszero.scene";
export const SCENE_FORMAT_VERSION = 1;

/* ---------------------------------------------------------------
 * CONSTRUCTION AND NORMALIZATION
 * -------------------------------------------------------------*/

export function createEmptyScene(options) {
  const opts = options || {};
  return normalizeScene({
    id: opts.id || "untitled-scene",
    name: opts.name || "Untitled Scene",
    description: "",
    steps: opts.steps || []
  });
}

let stepSeq = 0;

/**
 * Every step carries a `key`.
 *
 * It exists so the editor can keep a selection and a React list stable while
 * steps are reordered, and it is deliberately *not* written to disk — an
 * editor's bookkeeping is not part of the authored document, and letting it
 * leak would make two identical scenes diff against each other.
 */
function nextStepKey() {
  stepSeq += 1;
  return "s" + stepSeq;
}

export function normalizeStep(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const type = sceneStepType(source.type) ? source.type : "dialogue";
  const definition = SCENE_STEP_TYPES[type];
  const step = { ...definition.defaults(), ...source, type, key: source.key || nextStepKey() };
  // Unknown properties are kept. A step authored by a newer build that this
  // one does not understand should survive a round trip rather than be eaten.
  return step;
}

export function normalizeScene(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    format: SCENE_FORMAT_ID,
    formatVersion: SCENE_FORMAT_VERSION,
    id: String(source.id || "untitled-scene"),
    name: source.name || source.title || "Untitled Scene",
    description: source.description || "",
    steps: (Array.isArray(source.steps) ? source.steps : []).map(normalizeStep)
  };
}

/** A copy under a new id, ready to diverge. Steps get fresh keys. */
export function duplicateScene(scene, nextId) {
  const source = normalizeScene(scene);
  return normalizeScene({
    ...source,
    id: nextId || source.id + "-copy",
    name: source.name + " (copy)",
    steps: source.steps.map((step) => ({ ...step, key: undefined }))
  });
}

/* ---------------------------------------------------------------
 * VALIDATION
 * -------------------------------------------------------------*/

/**
 * `refs` is how validation reaches the content vocabulary without this module
 * importing the game. The editor passes the real registries; a test can pass
 * anything. Every predicate defaults to permissive, so a caller that only
 * cares about structure gets structural checks and no false alarms.
 */
export function sceneRefs(overrides) {
  const source = overrides || {};
  return {
    isSpeaker: source.isSpeaker || (() => true),
    speakerName: source.speakerName || ((id) => id),
    isExpression: source.isExpression || (() => true),
    isBackground: source.isBackground || (() => true),
    isMusicContext: source.isMusicContext || (() => true),
    knownSceneIds: source.knownSceneIds || []
  };
}

/**
 * Errors block export; warnings do not.
 *
 * Every problem names the step by its 1-based position, because "step 14" is
 * how the author is looking at it in the timeline.
 */
export function validateScene(rawScene, rawRefs) {
  const scene = normalizeScene(rawScene);
  const refs = sceneRefs(rawRefs);
  const errors = [];
  const warnings = [];

  if (!/^[a-z0-9][a-z0-9-]*$/i.test(scene.id)) {
    errors.push(
      'Scene id "' + scene.id + '" must be a stable slug: letters, digits and dashes.'
    );
  }
  if (scene.id === "untitled-scene") {
    warnings.push("Scene still has its placeholder id. Give it a stable one before exporting.");
  }
  if ((refs.knownSceneIds || []).filter((id) => id === scene.id).length > 1) {
    errors.push('Duplicate scene id "' + scene.id + '".');
  }
  if (!scene.name.trim()) warnings.push("Scene has no name.");
  if (!scene.steps.length) errors.push("Scene has no steps.");

  scene.steps.forEach((step, index) => {
    const label = "Step " + (index + 1) + " — " + (SCENE_STEP_TYPES[step.type] || {}).label;
    const definition = sceneStepType(step.type);
    if (!definition) {
      errors.push("Step " + (index + 1) + ' has unknown type "' + step.type + '".');
      return;
    }
    for (const problem of definition.validate(step, refs) || []) {
      if (problem && problem.warning) warnings.push(label + " " + problem.warning);
      else errors.push(label + " " + problem);
    }
  });

  // A scene the runtime can reach the end of. The player stops at the last
  // step regardless, so a missing `end` is a style warning rather than a bug.
  const hasEnd = scene.steps.some((step) => step.type === "end");
  if (scene.steps.length && !hasEnd) {
    warnings.push("Scene has no explicit End step; it will finish after the last step.");
  } else if (hasEnd && scene.steps[scene.steps.length - 1].type !== "end") {
    const endIndex = scene.steps.findIndex((step) => step.type === "end");
    warnings.push(
      "Step " + (endIndex + 1) + " ends the scene, so the " +
        (scene.steps.length - endIndex - 1) + " step(s) after it never run."
    );
  }
  if (!scene.steps.some((step) => step.type === "dialogue")) {
    warnings.push("Scene has no dialogue; nothing will wait for the player.");
  }

  return { ok: errors.length === 0, errors, warnings, scene };
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 * -------------------------------------------------------------*/

/** Field order is fixed so two equivalent scenes produce identical files. */
const STEP_FIELD_ORDER = [
  "type",
  "speaker",
  "character",
  "text",
  "expression",
  "position",
  "background",
  "label",
  "mode",
  "context",
  "track"
];

function orderStep(step) {
  const out = {};
  for (const key of STEP_FIELD_ORDER) {
    if (step[key] === undefined || step[key] === null || step[key] === "") continue;
    out[key] = step[key];
  }
  // Anything this build does not know about is preserved, after the known
  // fields, in a stable order.
  for (const key of Object.keys(step).sort()) {
    if (key === "key" || STEP_FIELD_ORDER.includes(key)) continue;
    if (step[key] === undefined) continue;
    out[key] = step[key];
  }
  return out;
}

export function serializeScene(scene) {
  const normalized = normalizeScene(scene);
  return (
    JSON.stringify(
      {
        format: SCENE_FORMAT_ID,
        formatVersion: SCENE_FORMAT_VERSION,
        id: normalized.id,
        name: normalized.name,
        description: normalized.description,
        steps: normalized.steps.map(orderStep)
      },
      null,
      2
    ) + "\n"
  );
}

export function parseScene(text) {
  return normalizeScene(typeof text === "string" ? JSON.parse(text) : text);
}

/* ---------------------------------------------------------------
 * THE STAGE FOLD
 *
 * The single reason `Play from here` is possible: the stage at any step is a
 * pure left fold over the steps before it. No hidden state, no animation
 * timers to unwind, no "you had to be there". Reconstructing step 37 of 60 is
 * the same operation as reaching it by playing, and produces the same result —
 * which a test asserts rather than assumes.
 * -------------------------------------------------------------*/

/** Stage state *after* applying steps `0..index`. */
export function stageAt(scene, index) {
  const normalized = normalizeScene(scene);
  let stage = createStage();
  const limit = Math.min(index, normalized.steps.length - 1);
  for (let i = 0; i <= limit; i += 1) {
    const step = normalized.steps[i];
    const definition = sceneStepType(step.type);
    if (!definition) continue;
    stage = definition.apply(stage, step);
    if (stage.ended) break;
  }
  return stage;
}

/** Stage state as it is *entering* a step — what `Play from here` starts on. */
export function stageBefore(scene, index) {
  if (index <= 0) return createStage();
  return stageAt(scene, index - 1);
}

/** Indices the player stops on. Everything else resolves without a click. */
export function blockingStepIndices(scene) {
  const normalized = normalizeScene(scene);
  const out = [];
  normalized.steps.forEach((step, index) => {
    const definition = sceneStepType(step.type);
    if (definition && definition.blocking) out.push(index);
  });
  return out;
}

/**
 * Runs from `from` to the next step the player must acknowledge.
 *
 * Returns the stage to draw and where the scene now sits. Presentation steps
 * between two lines all land in one beat, so a background change and a music
 * cue before a line cost the player nothing.
 */
export function advanceScene(scene, from, startStage) {
  const normalized = normalizeScene(scene);
  let stage = startStage || createStage();
  let index = Math.max(0, from);

  while (index < normalized.steps.length) {
    const step = normalized.steps[index];
    const definition = sceneStepType(step.type);
    if (!definition) {
      index += 1;
      continue;
    }
    stage = definition.apply(stage, step);
    if (stage.ended) return { stage, index, done: true };
    if (definition.blocking) return { stage, index, done: false };
    index += 1;
  }
  return { stage, index: normalized.steps.length - 1, done: true };
}

export function sceneStepCount(scene) {
  return normalizeScene(scene).steps.length;
}

export function sceneDialogueCount(scene) {
  return normalizeScene(scene).steps.filter((step) => step.type === "dialogue").length;
}
