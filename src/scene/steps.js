/* =========================================================================
 * SCENE STEP REGISTRY
 *
 * A scene is an ordered list of steps. That is the whole model — no graph, no
 * branching, no scripting language. Reading a scene top to bottom tells you
 * exactly what happens, in order, which is the property that makes the
 * timeline editor and the runtime agree without either knowing about the other.
 *
 * Every step type is one entry here, declaring:
 *
 *   label      what the editor calls it
 *   summary    the one-line description shown in the timeline
 *   fields     what the inspector should offer, and of what kind
 *   defaults   a new step of this type, ready to edit
 *   validate   problems, addressed to the author
 *   apply      how it changes the stage — the runtime's entire vocabulary
 *   blocking   whether the runtime stops here and waits for the player
 *
 * Adding a step type — camera moves, screen shake, a choice, a flag write — is
 * one entry in this table. Neither the editor nor the player has a switch on
 * step type anywhere: they both read this.
 *
 * Pure data and pure functions. No React, no engine imports.
 * =======================================================================*/

export const CHARACTER_POSITIONS = ["left", "center", "right"];

/** The stage: everything a step can change, and everything the player draws. */
export function createStage() {
  return {
    background: null,
    music: null,
    /** Ordered so a redraw is stable; keyed by character for cheap updates. */
    characters: [],
    /** The line currently on screen, or null between dialogue. */
    line: null,
    ended: false
  };
}

function upsertCharacter(stage, characterId, patch) {
  const characters = stage.characters.slice();
  const index = characters.findIndex((entry) => entry.character === characterId);
  if (index === -1) {
    characters.push({ character: characterId, position: "center", expression: null, ...patch });
  } else {
    characters[index] = { ...characters[index], ...patch };
  }
  return characters;
}

/** True for a value an author has actually filled in. */
function filled(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export const SCENE_STEP_TYPES = {
  dialogue: {
    label: "Dialogue",
    summary: (step, refs) =>
      (refs.speakerName(step.speaker) || step.speaker || "?") +
      ": " +
      (step.text ? '"' + truncate(step.text, 52) + '"' : "(no text)"),
    // `blocking` is what makes a scene readable: the runtime stops on dialogue
    // and nothing else, so presentation steps between two lines all land in
    // the same beat rather than each costing the player a click.
    blocking: true,
    fields: [
      { key: "speaker", label: "Speaker", kind: "speaker", required: true },
      { key: "text", label: "Text", kind: "text", required: true, rows: 4 },
      { key: "expression", label: "Expression", kind: "expression", optional: true },
      { key: "position", label: "Portrait side", kind: "position", optional: true }
    ],
    defaults: () => ({ speaker: "commander", text: "", expression: null, position: null }),
    validate(step, refs) {
      const problems = [];
      if (!filled(step.speaker)) problems.push("needs a speaker.");
      else if (!refs.isSpeaker(step.speaker)) {
        problems.push('references unknown character "' + step.speaker + '".');
      }
      if (!filled(step.text)) problems.push("has no dialogue text.");
      if (filled(step.position) && !CHARACTER_POSITIONS.includes(step.position)) {
        problems.push('has an unknown portrait side "' + step.position + '".');
      }
      return problems;
    },
    apply(stage, step) {
      // Speaking implies being on stage. An author who writes a line for a
      // character they never walked on should get the obvious result rather
      // than an invisible speaker.
      const patch = {};
      if (filled(step.expression)) patch.expression = step.expression;
      if (filled(step.position)) patch.position = step.position;
      return {
        ...stage,
        characters: upsertCharacter(stage, step.speaker, patch),
        line: { speaker: step.speaker, text: step.text }
      };
    }
  },

  characterEnter: {
    label: "Character enters",
    summary: (step, refs) =>
      (refs.speakerName(step.character) || step.character || "?") +
      " — " +
      (step.position || "center") +
      (filled(step.expression) ? " (" + step.expression + ")" : ""),
    blocking: false,
    fields: [
      { key: "character", label: "Character", kind: "speaker", required: true },
      { key: "position", label: "Position", kind: "position", required: true },
      { key: "expression", label: "Expression", kind: "expression", optional: true }
    ],
    defaults: () => ({ character: "commander", position: "left", expression: null }),
    validate(step, refs) {
      const problems = [];
      if (!filled(step.character)) problems.push("needs a character.");
      else if (!refs.isSpeaker(step.character)) {
        problems.push('references unknown character "' + step.character + '".');
      }
      if (!CHARACTER_POSITIONS.includes(step.position)) {
        problems.push(
          'has an unknown position "' + step.position + '" (expected ' +
            CHARACTER_POSITIONS.join(", ") + ")."
        );
      }
      return problems;
    },
    apply(stage, step) {
      return {
        ...stage,
        characters: upsertCharacter(stage, step.character, {
          position: step.position,
          expression: filled(step.expression) ? step.expression : null
        })
      };
    }
  },

  characterExit: {
    label: "Character exits",
    summary: (step, refs) => (refs.speakerName(step.character) || step.character || "?") + " leaves",
    blocking: false,
    fields: [{ key: "character", label: "Character", kind: "speaker", required: true }],
    defaults: () => ({ character: "commander" }),
    validate(step, refs) {
      if (!filled(step.character)) return ["needs a character."];
      if (!refs.isSpeaker(step.character)) {
        return ['references unknown character "' + step.character + '".'];
      }
      return [];
    },
    apply(stage, step) {
      return {
        ...stage,
        characters: stage.characters.filter((entry) => entry.character !== step.character)
      };
    }
  },

  expression: {
    label: "Expression",
    summary: (step, refs) =>
      (refs.speakerName(step.character) || step.character || "?") + " → " + (step.expression || "neutral"),
    blocking: false,
    fields: [
      { key: "character", label: "Character", kind: "speaker", required: true },
      { key: "expression", label: "Expression", kind: "expression", required: true }
    ],
    defaults: () => ({ character: "commander", expression: "concerned" }),
    validate(step, refs) {
      const problems = [];
      if (!filled(step.character)) problems.push("needs a character.");
      else if (!refs.isSpeaker(step.character)) {
        problems.push('references unknown character "' + step.character + '".');
      }
      if (!filled(step.expression)) problems.push("needs an expression.");
      else if (!refs.isExpression(step.expression)) {
        problems.push('uses unknown expression "' + step.expression + '".');
      }
      return problems;
    },
    apply(stage, step) {
      return {
        ...stage,
        characters: upsertCharacter(stage, step.character, { expression: step.expression })
      };
    }
  },

  background: {
    label: "Background",
    summary: (step) => step.background || "(none)",
    blocking: false,
    fields: [
      { key: "background", label: "Background", kind: "background", required: true },
      { key: "label", label: "Location caption", kind: "line", optional: true }
    ],
    defaults: () => ({ background: "", label: "" }),
    validate(step, refs) {
      if (!filled(step.background)) return ["needs a background."];
      // An unknown id is a warning, not an error: art arrives after writing,
      // and the asset layer already renders a readable placeholder.
      if (!refs.isBackground(step.background)) {
        return [{ warning: 'background "' + step.background + '" has no asset convention yet.' }];
      }
      return [];
    },
    apply(stage, step) {
      return {
        ...stage,
        background: { id: step.background, label: filled(step.label) ? step.label : null }
      };
    }
  },

  music: {
    label: "Music",
    summary: (step) =>
      step.mode === "stop" ? "stop" : (step.context || step.track || "(none)"),
    blocking: false,
    fields: [
      { key: "mode", label: "Mode", kind: "enum", options: ["play", "stop"], required: true },
      { key: "context", label: "Context", kind: "musicContext", optional: true },
      { key: "track", label: "Specific track", kind: "line", optional: true }
    ],
    defaults: () => ({ mode: "play", context: "briefing", track: "" }),
    validate(step, refs) {
      const problems = [];
      if (step.mode !== "play" && step.mode !== "stop") {
        problems.push('has an unknown mode "' + step.mode + '" (expected play or stop).');
      }
      if (step.mode === "play" && !filled(step.context) && !filled(step.track)) {
        problems.push("needs a context or a specific track to play.");
      }
      if (filled(step.context) && !refs.isMusicContext(step.context)) {
        problems.push('references unknown music context "' + step.context + '".');
      }
      return problems;
    },
    apply(stage, step) {
      if (step.mode === "stop") return { ...stage, music: null };
      return {
        ...stage,
        music: { context: filled(step.context) ? step.context : null, track: filled(step.track) ? step.track : null }
      };
    }
  },

  clear: {
    label: "Clear stage",
    summary: () => "everyone leaves",
    blocking: false,
    fields: [],
    defaults: () => ({}),
    validate: () => [],
    apply(stage) {
      return { ...stage, characters: [], line: null };
    }
  },

  end: {
    label: "End scene",
    summary: () => "scene ends",
    blocking: false,
    fields: [],
    defaults: () => ({}),
    validate: () => [],
    apply(stage) {
      return { ...stage, ended: true, line: null };
    }
  }
};

export const SCENE_STEP_IDS = Object.keys(SCENE_STEP_TYPES);

export function sceneStepType(type) {
  return SCENE_STEP_TYPES[type] || null;
}

/** Step types offered in the editor's "add step" menu, in a sensible order. */
export const SCENE_STEP_PALETTE = [
  "dialogue",
  "characterEnter",
  "expression",
  "characterExit",
  "background",
  "music",
  "clear",
  "end"
];

function truncate(text, limit) {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

export { truncate as truncateSummary };
