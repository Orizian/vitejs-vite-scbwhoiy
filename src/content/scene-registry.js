/* =========================================================================
 * SCENE REGISTRY
 *
 * Every authored scene that should exist in this build. Deliberately shaped
 * like `mission-registry.js`, because a scene is content in exactly the way a
 * mission is: drop a file in `src/content/scenes/` and it is in the game.
 *
 * Two sources, in this order:
 *
 *   1. src/content/scenes/*.json — checked in, shipped.
 *   2. The editor's preview slot — written by the Scene editor's Preview
 *      button so a scene can be watched in the real player before it is
 *      exported. Cleared explicitly, never on read.
 *
 * A scene needs no map and no encounter, so unlike missions this registry
 * compiles to nothing: an authored scene *is* the runtime representation.
 * =======================================================================*/

import { normalizeScene, validateScene } from "../scene/format.js";
import { SPEAKER_IDS, EXPRESSION_IDS, BACKGROUND_IDS, MUSIC_CONTEXT_IDS } from "./catalog.js";

export const SCENE_PREVIEW_STORAGE_KEY = "statuszero.scene.preview";

const files = import.meta.glob("./scenes/*.json", { eager: true });

/** The content vocabulary a scene is checked against, shared by the editor. */
export function contentSceneRefs(knownSceneIds) {
  return {
    isSpeaker: (id) => SPEAKER_IDS.includes(id),
    speakerName: (id) => id,
    isExpression: (id) => EXPRESSION_IDS.includes(id),
    isBackground: (id) => BACKGROUND_IDS.includes(id),
    isMusicContext: (id) => MUSIC_CONTEXT_IDS.includes(id),
    knownSceneIds: knownSceneIds || []
  };
}

function readPreviewScene() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SCENE_PREVIEW_STORAGE_KEY);
    if (!raw) return null;
    return normalizeScene(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writePreviewScene(scene) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(SCENE_PREVIEW_STORAGE_KEY, JSON.stringify(scene));
    return true;
  } catch {
    return false;
  }
}

export function clearPreviewScene() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(SCENE_PREVIEW_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

function collect() {
  const scenes = {};
  const errors = [];
  const warnings = [];
  let previewSceneId = null;

  const add = (raw, origin, options) => {
    let scene;
    try {
      scene = normalizeScene(raw);
    } catch (error) {
      errors.push(origin + ": could not be read (" + error.message + ")");
      return null;
    }
    const report = validateScene(scene, contentSceneRefs(Object.keys(scenes)));
    for (const message of report.errors) errors.push(origin + ": " + message);
    for (const message of report.warnings) warnings.push(origin + ": " + message);
    if (!report.ok) return null;

    if (scenes[scene.id] && !(options && options.replaceExisting)) {
      errors.push(origin + ': duplicate scene id "' + scene.id + '".');
      return null;
    }
    scenes[scene.id] = { ...report.scene, origin };
    return report.scene;
  };

  for (const path of Object.keys(files).sort()) {
    const module = files[path];
    add(module && module.default ? module.default : module, path);
  }

  const preview = readPreviewScene();
  if (preview) {
    const added = add(preview, "preview slot", { replaceExisting: true });
    if (added) previewSceneId = added.id;
  }

  return { scenes, errors, warnings, previewSceneId };
}

export const SCENE_CONTENT = collect();

export function sceneById(sceneId) {
  return (sceneId && SCENE_CONTENT.scenes[sceneId]) || null;
}

export function allSceneIds() {
  return Object.keys(SCENE_CONTENT.scenes).sort();
}
