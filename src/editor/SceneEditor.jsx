import React from "react";
import { Btn } from "./panels.jsx";
import {
  createEmptyScene,
  normalizeScene,
  normalizeStep,
  validateScene,
  serializeScene,
  parseScene,
  duplicateScene,
  sceneStepCount,
  sceneDialogueCount
} from "../scene/format.js";
import { SCENE_STEP_TYPES, SCENE_STEP_PALETTE, CHARACTER_POSITIONS } from "../scene/steps.js";
import { SCENE_CONTENT, contentSceneRefs } from "../content/scene-registry.js";
import {
  SPEAKER_CATALOG,
  EXPRESSION_CATALOG,
  BACKGROUND_CATALOG,
  MUSIC_CONTEXT_IDS
} from "../content/catalog.js";

/* =========================================================================
 * STATUS ZERO — SCENE EDITOR
 *
 * A scene is an ordered list of steps, so this is an ordered list of steps
 * with an inspector beside it. Deliberately not a node graph: reading a scene
 * top to bottom is the whole point, and a timeline is the shape that matches.
 *
 * Three columns, left to right, following the order you actually work in:
 *
 *   library     which scene am I editing
 *   timeline    what happens, in order
 *   inspector   the fields of the selected step, from the step registry
 *
 * The inspector has no knowledge of step types. It renders whatever
 * `SCENE_STEP_TYPES[type].fields` declares, so a new step type is one entry in
 * that table and appears here with no change to this file.
 *
 * Like the mission editor, this imports the format and the catalog — never
 * App.jsx. Preview is handed up to the host, which runs the real game player.
 * =======================================================================*/

const DRAFT_KEY = "statuszero.scene.draft";
const LIBRARY_KEY = "statuszero.scene.library";
const HISTORY_LIMIT = 60;

function readLocalLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalLibrary(library) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch {
    /* storage may be unavailable */
  }
}

const speakerName = (id) => {
  const entry = SPEAKER_CATALOG.find((speaker) => speaker.id === id);
  return entry ? entry.name : id;
};

export default function SceneEditor({ onPreview, previewLabel }) {
  const [scene, setScene] = React.useState(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) return normalizeScene(JSON.parse(stored));
    } catch {
      /* fall through to a blank scene */
    }
    return createEmptyScene();
  });
  const [selected, setSelected] = React.useState(0);
  const [library, setLibrary] = React.useState(readLocalLibrary);
  const [filter, setFilter] = React.useState("");
  const [note, setNote] = React.useState("");
  const history = React.useRef({ past: [], future: [] });
  const fileInput = React.useRef(null);
  const textRef = React.useRef(null);
  const focusText = React.useRef(false);

  const flash = (message) => {
    setNote(message);
    setTimeout(() => setNote((current) => (current === message ? "" : current)), 2600);
  };

  /* ---- editing with undo ---- */

  const commit = React.useCallback((next, options) => {
    setScene((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (!(options && options.silent)) {
        history.current.past.push(current);
        if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
        history.current.future = [];
      }
      return value;
    });
  }, []);

  const undo = () => {
    const previous = history.current.past.pop();
    if (!previous) return;
    setScene((current) => {
      history.current.future.push(current);
      return previous;
    });
  };

  const redo = () => {
    const next = history.current.future.pop();
    if (!next) return;
    setScene((current) => {
      history.current.past.push(current);
      return next;
    });
  };

  React.useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(scene));
    } catch {
      /* storage may be unavailable */
    }
  }, [scene]);

  React.useEffect(() => {
    if (!focusText.current) return;
    focusText.current = false;
    if (textRef.current) {
      textRef.current.focus();
      textRef.current.select();
    }
  }, [selected, scene]);

  /* ---- step operations ---- */

  const steps = scene.steps;
  const step = steps[selected] || null;
  const definition = step ? SCENE_STEP_TYPES[step.type] : null;

  const replaceSteps = (nextSteps, nextSelected) => {
    commit((current) => ({ ...current, steps: nextSteps }));
    if (nextSelected != null) setSelected(Math.max(0, Math.min(nextSteps.length - 1, nextSelected)));
  };

  const insertStep = (type, at, patch) => {
    const created = normalizeStep({ type, ...patch });
    const index = at == null ? steps.length : Math.max(0, Math.min(steps.length, at));
    const next = steps.slice(0, index).concat(created, steps.slice(index));
    replaceSteps(next, index);
    return index;
  };

  /**
   * The fast path. Adding a line inherits the previous line's speaker and
   * portrait side, so writing a two-hander is: type, Ctrl+Enter, type.
   * The inherited values are written into the step like any other, so the
   * saved document never depends on knowing this shortcut existed.
   */
  const addDialogueAfter = (index) => {
    let previous = null;
    for (let i = Math.min(index, steps.length - 1); i >= 0; i -= 1) {
      if (steps[i] && steps[i].type === "dialogue") {
        previous = steps[i];
        break;
      }
    }
    focusText.current = true;
    return insertStep("dialogue", index + 1, {
      speaker: previous ? previous.speaker : "commander",
      position: previous ? previous.position : null,
      text: ""
    });
  };

  const moveStep = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    replaceSteps(next, target);
  };

  const duplicateStep = (index) => {
    const copy = normalizeStep({ ...steps[index], key: undefined });
    const next = steps.slice(0, index + 1).concat(copy, steps.slice(index + 1));
    replaceSteps(next, index + 1);
  };

  const deleteStep = (index) => {
    const next = steps.filter((_, i) => i !== index);
    replaceSteps(next, Math.min(index, next.length - 1));
  };

  const patchStep = (index, patch) => {
    commit((current) => ({
      ...current,
      steps: current.steps.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))
    }));
  };

  /* ---- library ---- */

  const shipped = Object.values(SCENE_CONTENT.scenes);
  const localScenes = Object.values(library);
  const allScenes = shipped
    .map((entry) => ({ ...entry, source: "shipped" }))
    .concat(localScenes.map((entry) => ({ ...entry, source: "local" })));
  const knownIds = allScenes.map((entry) => entry.id);
  const visible = allScenes.filter((entry) => {
    if (!filter.trim()) return true;
    const needle = filter.trim().toLowerCase();
    return entry.id.toLowerCase().includes(needle) || (entry.name || "").toLowerCase().includes(needle);
  });

  const openScene = (entry) => {
    commit(normalizeScene(entry));
    setSelected(0);
    flash("Opened " + entry.id);
  };

  const saveToLibrary = () => {
    const next = { ...library, [scene.id]: normalizeScene(scene) };
    setLibrary(next);
    writeLocalLibrary(next);
    flash("Saved " + scene.id + " to the local library.");
  };

  const removeFromLibrary = (sceneId) => {
    const next = { ...library };
    delete next[sceneId];
    setLibrary(next);
    writeLocalLibrary(next);
    flash("Removed " + sceneId + " from the local library.");
  };

  const doDuplicate = () => {
    const nextId = prompt("New scene id", scene.id + "-copy");
    if (!nextId) return;
    commit(duplicateScene(scene, nextId.trim()));
    setSelected(0);
    flash("Duplicated as " + nextId.trim());
  };

  const doExport = () => {
    const text = serializeScene(scene);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = scene.id + ".json";
    anchor.click();
    URL.revokeObjectURL(url);
    flash("Exported " + scene.id + ".json — drop it in src/content/scenes/");
  };

  const doImport = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        commit(parseScene(String(reader.result)));
        setSelected(0);
        flash("Imported " + file.name);
      } catch (error) {
        flash("Could not read that file: " + error.message);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  /* ---- validation ---- */

  const refs = React.useMemo(
    () => ({ ...contentSceneRefs(knownIds), speakerName }),
    [knownIds.join(",")]
  );
  const report = React.useMemo(() => validateScene(scene, refs), [scene, refs]);

  const preview = (startIndex) => {
    if (!onPreview) return;
    onPreview(normalizeScene(scene), startIndex || 0);
  };

  return (
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      {/* ---- top bar ---- */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        <input
          value={scene.id}
          onChange={(event) => commit((current) => ({ ...current, id: event.target.value }))}
          className="w-56 rounded border border-slate-600 bg-slate-900 px-2 py-1 font-mono text-[12px] text-sky-200"
          placeholder="scene-id"
          title="Stable id. Missions and other scenes reference this."
        />
        <input
          value={scene.name}
          onChange={(event) => commit((current) => ({ ...current, name: event.target.value }))}
          className="w-64 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[12px]"
          placeholder="Scene name"
        />
        <Btn onClick={() => { commit(createEmptyScene()); setSelected(0); }}>New</Btn>
        <Btn onClick={() => fileInput.current.click()}>Import…</Btn>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={doImport} />
        <Btn onClick={doDuplicate}>Duplicate…</Btn>
        <Btn tone="emerald" onClick={doExport} disabled={!report.ok} title={report.ok ? "" : "Fix errors first"}>
          Export…
        </Btn>
        <Btn onClick={saveToLibrary} disabled={!report.ok} title={report.ok ? "" : "Fix errors first"}>
          Save to library
        </Btn>
        <span className="mx-1 h-5 w-px bg-slate-700" />
        <Btn onClick={undo} title="Undo">↶</Btn>
        <Btn onClick={redo} title="Redo">↷</Btn>
        <span className="mx-1 h-5 w-px bg-slate-700" />
        <Btn tone="sky" onClick={() => preview(0)} disabled={!onPreview || !steps.length}>
          ▶ {previewLabel || "Preview"}
        </Btn>
        <Btn
          tone="sky"
          onClick={() => preview(selected)}
          disabled={!onPreview || !steps.length}
          title="Start the real player at the selected step"
        >
          ▶ From step {selected + 1}
        </Btn>
        <span className="ml-auto text-[11px] text-slate-500">
          {note || sceneStepCount(scene) + " steps · " + sceneDialogueCount(scene) + " lines"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- library ---- */}
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 p-2">
            <p className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">Scene library</p>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter…"
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length === 0 ? (
              <p className="p-3 text-[11px] text-slate-600">No scenes yet.</p>
            ) : (
              visible.map((entry) => (
                <div
                  key={entry.source + ":" + entry.id}
                  className={
                    "border-b border-slate-800/70 px-3 py-2 " +
                    (entry.id === scene.id ? "bg-sky-950/40" : "hover:bg-slate-800/40")
                  }
                >
                  <button onClick={() => openScene(entry)} className="block w-full text-left">
                    <p className="truncate font-mono text-[11px] text-sky-300">{entry.id}</p>
                    <p className="truncate text-[11px] text-slate-300">{entry.name}</p>
                    <p className="text-[10px] text-slate-600">
                      {(entry.steps || []).length} steps · {entry.source}
                    </p>
                  </button>
                  {entry.source === "local" ? (
                    <button
                      onClick={() => removeFromLibrary(entry.id)}
                      className="mt-1 text-[10px] text-rose-400 hover:text-rose-300"
                    >
                      remove
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---- timeline ---- */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="mr-2 text-[10px] uppercase tracking-widest text-slate-500">Add</span>
            {SCENE_STEP_PALETTE.map((type) => (
              <Btn
                key={type}
                tone={type === "dialogue" ? "sky" : "slate"}
                onClick={() =>
                  type === "dialogue" ? addDialogueAfter(selected) : insertStep(type, selected + 1)
                }
              >
                {SCENE_STEP_TYPES[type].label}
              </Btn>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {steps.length === 0 ? (
              <p className="p-4 text-[12px] text-slate-500">
                Empty scene. Add a Background, then a Dialogue step.
              </p>
            ) : (
              <ol>
                {steps.map((entry, index) => {
                  const type = SCENE_STEP_TYPES[entry.type];
                  const isSelected = index === selected;
                  return (
                    <li
                      key={entry.key}
                      className={
                        "flex items-start gap-2 border-b border-slate-800/60 px-3 py-2 " +
                        (isSelected ? "bg-sky-950/40" : "hover:bg-slate-800/30")
                      }
                    >
                      <button
                        onClick={() => setSelected(index)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <span className="w-7 shrink-0 pt-[2px] text-right font-mono text-[11px] text-slate-600">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span
                          className={
                            "w-[112px] shrink-0 text-[11px] uppercase tracking-wider " +
                            (entry.type === "dialogue" ? "text-sky-300" : "text-slate-400")
                          }
                        >
                          {type ? type.label : entry.type}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">
                          {type ? type.summary(entry, refs) : "unknown step type"}
                        </span>
                      </button>
                      <span className="flex shrink-0 gap-1">
                        <Btn onClick={() => moveStep(index, -1)} title="Move up">↑</Btn>
                        <Btn onClick={() => moveStep(index, 1)} title="Move down">↓</Btn>
                        <Btn onClick={() => duplicateStep(index)} title="Duplicate">⧉</Btn>
                        <Btn tone="rose" onClick={() => deleteStep(index)} title="Delete">✕</Btn>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>

        {/* ---- inspector + validation ---- */}
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <p className="mb-3 text-[10px] uppercase tracking-widest text-slate-500">
              {step ? "Step " + (selected + 1) + " — " + definition.label : "No step selected"}
            </p>
            {step ? (
              <div className="space-y-3">
                {definition.fields.length === 0 ? (
                  <p className="text-[11px] text-slate-600">This step has no options.</p>
                ) : null}
                {definition.fields.map((field) => (
                  <StepField
                    key={field.key}
                    field={field}
                    value={step[field.key]}
                    textRef={field.kind === "text" ? textRef : null}
                    onChange={(value) => patchStep(selected, { [field.key]: value })}
                    onQuickNext={
                      field.kind === "text" ? () => setSelected(addDialogueAfter(selected)) : null
                    }
                  />
                ))}
                {step.type === "dialogue" ? (
                  <p className="text-[10px] leading-relaxed text-slate-600">
                    Ctrl/⌘+Enter in the text box adds the next line below, keeping this speaker and
                    side. The new step stores them explicitly.
                  </p>
                ) : null}
                <div className="flex gap-1 pt-2">
                  <Btn onClick={() => setSelected(addDialogueAfter(selected))}>+ Line below</Btn>
                  <Btn onClick={() => insertStep(step.type, selected)}>Insert above</Btn>
                </div>
              </div>
            ) : null}
          </div>

          <div className="max-h-[42%] overflow-auto border-t border-slate-800">
            <div
              className={
                "px-3 py-2 text-[11px] font-bold uppercase tracking-widest " +
                (report.errors.length
                  ? "bg-rose-950/60 text-rose-200"
                  : report.warnings.length
                  ? "bg-amber-950/40 text-amber-200"
                  : "bg-emerald-950/40 text-emerald-200")
              }
            >
              {report.errors.length
                ? report.errors.length + " error" + (report.errors.length === 1 ? "" : "s") + " — will not export"
                : report.warnings.length
                ? "Valid · " + report.warnings.length + " warning" + (report.warnings.length === 1 ? "" : "s")
                : "Valid · no warnings"}
            </div>
            <div className="space-y-1 p-2">
              {report.errors.map((message, index) => (
                <p key={"e" + index} className="border-l-2 border-rose-500 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-200">
                  {message}
                </p>
              ))}
              {report.warnings.map((message, index) => (
                <p key={"w" + index} className="border-l-2 border-amber-500 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-200">
                  {message}
                </p>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * One inspector control, chosen by the field's declared `kind`.
 *
 * This is the only place that maps a field kind to a widget, which is why a
 * new step type needs no change here — only a `fields` entry using kinds that
 * already exist, or one new case below.
 */
function StepField({ field, value, onChange, onQuickNext, textRef }) {
  const label = (
    <span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">
      {field.label}
      {field.optional ? " (optional)" : ""}
    </span>
  );
  const box = "w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[12px] text-slate-100";

  if (field.kind === "text") {
    return (
      <label className="block">
        {label}
        <textarea
          ref={textRef}
          rows={field.rows || 4}
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && onQuickNext) {
              event.preventDefault();
              onQuickNext();
            }
          }}
          className={box + " resize-y leading-relaxed"}
        />
      </label>
    );
  }

  if (field.kind === "speaker") {
    return (
      <label className="block">
        {label}
        <select value={value || ""} onChange={(event) => onChange(event.target.value)} className={box}>
          {SPEAKER_CATALOG.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.name}
            </option>
          ))}
          {value && !SPEAKER_CATALOG.some((speaker) => speaker.id === value) ? (
            <option value={value}>{value} (unknown)</option>
          ) : null}
        </select>
      </label>
    );
  }

  if (field.kind === "expression") {
    return (
      <label className="block">
        {label}
        <select value={value || ""} onChange={(event) => onChange(event.target.value || null)} className={box}>
          <option value="">— unchanged —</option>
          {EXPRESSION_CATALOG.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "position") {
    return (
      <label className="block">
        {label}
        <select value={value || ""} onChange={(event) => onChange(event.target.value || null)} className={box}>
          {field.optional ? <option value="">— unchanged —</option> : null}
          {CHARACTER_POSITIONS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "background") {
    return (
      <label className="block">
        {label}
        <input
          list="statuszero-backgrounds"
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          className={box}
          placeholder="warner-road"
        />
        <datalist id="statuszero-backgrounds">
          {BACKGROUND_CATALOG.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </datalist>
      </label>
    );
  }

  if (field.kind === "musicContext") {
    return (
      <label className="block">
        {label}
        <select value={value || ""} onChange={(event) => onChange(event.target.value || null)} className={box}>
          <option value="">— none —</option>
          {MUSIC_CONTEXT_IDS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "enum") {
    return (
      <label className="block">
        {label}
        <select value={value || ""} onChange={(event) => onChange(event.target.value)} className={box}>
          {(field.options || []).map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input value={value || ""} onChange={(event) => onChange(event.target.value)} className={box} />
    </label>
  );
}
