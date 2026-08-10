import React from "react";
import MapCanvas from "./MapCanvas.jsx";
import {
  MapPanel,
  UnitsPanel,
  RegionsPanel,
  ObjectivePanel,
  ScenesPanel,
  BeatsPanel,
  ValidationPanel,
  MissionPanel,
  Btn
} from "./panels.jsx";
import {
  FactionsPanel,
  GroupsPanel,
  ObjectiveLibraryPanel,
  PhasesPanel,
  TriggersPanel
} from "./scriptPanels.jsx";
import {
  createEmptyMission,
  normalizeMission,
  validateMission,
  serializeMission,
  parseMission
} from "../content/mission-format.js";
import { PLAYTEST_STORAGE_KEY } from "../content/mission-registry.js";
import { terrainById } from "../content/catalog.js";
import { writePreviewScene } from "../content/scene-registry.js";
import { buildArenaMission } from "../content/gameplay/arena.js";
import arenaFixture from "../content/missions/fixture-test-arena.json";

/* =========================================================================
 * STATUS ZERO — MISSION EDITOR
 *
 * A standalone tool that shares exactly one thing with the game: the mission
 * format module. It never imports App.jsx, so it stays fast and cannot be
 * broken by a change to the renderer.
 *
 * The loop it is built around:
 *   paint  ->  validate (live)  ->  Playtest (opens the game on this map)
 *   ->  Export  ->  drop the file in src/content/missions/  ->  shipped
 * =======================================================================*/

const TABS = [
  { id: "mission", label: "Mission" },
  { id: "map", label: "Map" },
  { id: "units", label: "Units" },
  { id: "regions", label: "Regions" },
  { id: "factions", label: "Factions" },
  { id: "groups", label: "Groups" },
  { id: "objectives", label: "Objectives" },
  { id: "phases", label: "Phases" },
  { id: "triggers", label: "Triggers" },
  { id: "scenes", label: "Briefing lines" },
  { id: "objective", label: "Fallback" },
  { id: "barks", label: "Barks" }
];

/* The two secondary authoring modes, split out of the mission editor's chunk.
 * Opening a map to paint a tile should not download the scene timeline or the
 * gameplay schema, validation and exchange layers — the same reasoning that
 * keeps the whole editor out of the game's bundle. */
const LazySceneEditor = React.lazy(() => import("./SceneEditor.jsx"));
const LazyGameplayStudio = React.lazy(() => import("./GameplayStudio.jsx"));

function ModeLoading({ label }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-[11px] uppercase tracking-[0.24em] text-slate-600">
      {label}
    </div>
  );
}

const AUTOSAVE_KEY = "statuszero.editor.draft";
const EDITOR_MODE_KEY = "statuszero.editor.mode";
const EDITOR_MODES = ["mission", "scene", "gameplay"];
const HISTORY_LIMIT = 60;

/**
 * @param onExit  Supplied when the editor is mounted as a route inside the
 *                game shell: leaving is then a state change, not a page load.
 *                Standalone (`editor.html`) there is no such handler, so the
 *                same control navigates to the game's front door instead.
 *                Either way the button is present and does the obvious thing.
 */
/**
 * The editor shell.
 *
 * Three authoring modes, and they share everything worth sharing: the content
 * catalog, the validation style, the export/import workflow and this chrome.
 * Missions, scenes and gameplay data are different documents, not different
 * tools — and all three edit the files the game actually loads.
 *
 * @param onScenePreview  Hands a scene up to the host to run in the real game
 *                        player. Absent when the editor runs standalone, where
 *                        preview opens the game in a new tab instead.
 */
export default function Editor({ onExit, onScenePreview }) {
  const [mode, setMode] = React.useState(() => {
    try {
      const stored = localStorage.getItem(EDITOR_MODE_KEY);
      return EDITOR_MODES.includes(stored) ? stored : "mission";
    } catch {
      return "mission";
    }
  });
  const chooseMode = React.useCallback((next) => {
    setMode(next);
    try {
      localStorage.setItem(EDITOR_MODE_KEY, next);
    } catch {
      /* storage may be unavailable */
    }
  }, []);

  const leaveEditor = React.useCallback(() => {
    if (typeof onExit === "function") {
      onExit();
      return;
    }
    if (typeof window !== "undefined") window.location.href = "/";
  }, [onExit]);

  const [mission, setMission] = React.useState(() => {
    try {
      const stored = localStorage.getItem(AUTOSAVE_KEY);
      if (stored) return normalizeMission(JSON.parse(stored));
    } catch {
      /* fall through to a blank mission */
    }
    return createEmptyMission({ width: 36, height: 48 });
  });

  const [tab, setTab] = React.useState("map");
  const [tool, setTool] = React.useState("paint");
  const [brush, setBrush] = React.useState(1);
  const [activeTerrainId, setActiveTerrainId] = React.useState("wall");
  const [activeUnitDefinitionId, setActiveUnitDefinitionId] = React.useState("rifleGrunt");
  const [activeTeamId, setActiveTeamId] = React.useState("foe");
  const [elevationDelta, setElevationDelta] = React.useState(1);
  const [selectedUnitRef, setSelectedUnitRef] = React.useState(null);
  const [selectedRegionId, setSelectedRegionId] = React.useState(null);
  const [selectedSceneId, setSelectedSceneId] = React.useState(null);
  const [selectedBeatId, setSelectedBeatId] = React.useState(null);
  const [selectedPhaseId, setSelectedPhaseId] = React.useState(null);
  const [selectedTriggerId, setSelectedTriggerId] = React.useState(null);
  const [showElevation, setShowElevation] = React.useState(true);
  const [showRegions, setShowRegions] = React.useState(true);
  const [showUnits, setShowUnits] = React.useState(true);
  const [showGrid, setShowGrid] = React.useState(true);
  const [camera, setCamera] = React.useState({ zoom: 18, x: 24, y: 24 });
  const [status, setStatus] = React.useState("");

  const history = React.useRef({ past: [], future: [] });
  const strokeSnapshot = React.useRef(null);
  const fileInput = React.useRef(null);

  /* ---- autosave so a refresh never loses work ---- */
  // Skips the run on mount. What is in state at that point is either exactly
  // what was just read from storage — writing it back achieves nothing — or a
  // blank mission nobody asked to save, and saving that would overwrite a
  // draft another tab is holding. Only an actual edit is worth persisting.
  const savedOnce = React.useRef(false);
  React.useEffect(() => {
    if (!savedOnce.current) {
      savedOnce.current = true;
      return undefined;
    }
    const id = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(mission));
      } catch {
        /* quota — the export button is still the real save */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [mission]);

  const report = React.useMemo(() => validateMission(mission), [mission]);

  /* ---- edits ----
   * `update` takes a mutator over a structural clone, so panels can write
   * plainly (draft.units.push(...)) while state stays immutable. */
  const update = React.useCallback((mutate, options) => {
    setMission((current) => {
      const draft = structuredClone(current);
      mutate(draft);
      if (!(options && options.silent)) {
        history.current.past.push(current);
        if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
        history.current.future = [];
      }
      return draft;
    });
  }, []);

  const undo = React.useCallback(() => {
    setMission((current) => {
      const previous = history.current.past.pop();
      if (!previous) return current;
      history.current.future.push(current);
      return previous;
    });
  }, []);

  const redo = React.useCallback(() => {
    setMission((current) => {
      const next = history.current.future.pop();
      if (!next) return current;
      history.current.past.push(current);
      return next;
    });
  }, []);

  /* ---- painting ----
   * A drag is one undo step: snapshot on pointer-down, push it on pointer-up. */
  const onPaint = React.useCallback(
    (point, phase) => {
      if (phase === "start") strokeSnapshot.current = mission;

      const radius = tool === "unit" ? 0 : brush - 1;
      const tiles = [];
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          tiles.push({ x: point.x + dx, y: point.y + dy });
        }
      }

      update(
        (draft) => {
          const inside = (t) => t.x >= 0 && t.y >= 0 && t.x < draft.map.width && t.y < draft.map.height;

          if (tool === "paint") {
            for (const t of tiles) if (inside(t)) draft.map.terrain[t.y][t.x] = activeTerrainId;
            return;
          }

          if (tool === "elevation") {
            for (const t of tiles) {
              if (!inside(t)) continue;
              const current = draft.map.elevation[t.y][t.x];
              draft.map.elevation[t.y][t.x] =
                elevationDelta === 0 ? 0 : Math.max(0, Math.min(35, current + elevationDelta));
            }
            return;
          }

          if (tool === "region") {
            const region = draft.regions.find((entry) => entry.id === selectedRegionId);
            if (!region) return;
            const key = (t) => t.x + "," + t.y;
            const have = new Set(region.tiles.map(key));
            for (const t of tiles) {
              if (!inside(t) || have.has(key(t))) continue;
              have.add(key(t));
              region.tiles.push({ x: t.x, y: t.y });
            }
            return;
          }

          if (tool === "erase") {
            const keys = new Set(tiles.map((t) => t.x + "," + t.y));
            draft.units = draft.units.filter((unit) => !keys.has(unit.x + "," + unit.y));
            for (const region of draft.regions) {
              region.tiles = region.tiles.filter((t) => !keys.has(t.x + "," + t.y));
            }
            for (const t of tiles) if (inside(t)) draft.map.terrain[t.y][t.x] = "plain";
            return;
          }

          if (tool === "unit") {
            if (!inside(point)) return;
            if (draft.units.some((unit) => unit.x === point.x && unit.y === point.y)) return;
            const prefix = activeTeamId === "player" ? "squad" : activeTeamId === "foe" ? "hostile" : "unit";
            let n = draft.units.length + 1;
            let ref = prefix + n;
            while (draft.units.some((unit) => unit.ref === ref)) {
              n += 1;
              ref = prefix + n;
            }
            draft.units.push({
              ref,
              definitionId: activeUnitDefinitionId,
              teamId: activeTeamId,
              x: point.x,
              y: point.y,
              facing: null,
              aiProfile: null,
              group: null,
              note: ""
            });
          }
        },
        { silent: true }
      );
    },
    [tool, brush, activeTerrainId, elevationDelta, selectedRegionId, activeTeamId, activeUnitDefinitionId, update, mission]
  );

  const onPaintEnd = React.useCallback(() => {
    const snapshot = strokeSnapshot.current;
    strokeSnapshot.current = null;
    if (!snapshot) return;
    history.current.past.push(snapshot);
    if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
    history.current.future = [];
  }, []);

  /* ---- keyboard ---- */
  React.useEffect(() => {
    const onKey = (event) => {
      const target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      const tools = { b: "paint", e: "elevation", u: "unit", r: "region", x: "erase", v: "select" };
      if (tools[event.key.toLowerCase()]) setTool(tools[event.key.toLowerCase()]);
      if (event.key === "[") setBrush((value) => Math.max(1, value - 1));
      if (event.key === "]") setBrush((value) => Math.min(8, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /* ---- file actions ---- */
  const flash = (message) => {
    setStatus(message);
    setTimeout(() => setStatus(""), 3200);
  };

  const doExport = async () => {
    const text = serializeMission(mission);
    const filename = mission.id + ".json";
    // Chrome's file picker can write straight into src/content/missions/,
    // which removes the "download then move it" step entirely.
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "Status Zero mission", accept: { "application/json": [".json"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        flash("Saved " + filename);
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    flash("Downloaded " + filename + " — move it into src/content/missions/");
  };

  const doImport = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loaded = parseMission(String(reader.result));
        history.current = { past: [], future: [] };
        setMission(loaded);
        setSelectedUnitRef(null);
        setSelectedRegionId(null);
        setSelectedSceneId(null);
        setSelectedBeatId(null);
        flash("Opened " + (file.name || "mission"));
      } catch (error) {
        flash("Could not open: " + error.message);
      }
    };
    reader.readAsText(file);
  };

  const doPlaytest = () => {
    if (!report.ok) {
      flash("Fix the errors first — the game will refuse to load this mission.");
      return;
    }
    localStorage.setItem(PLAYTEST_STORAGE_KEY, JSON.stringify(mission));
    window.open("/", "_blank");
    flash("Playtest opened in a new tab.");
  };

  const fitToMap = React.useCallback(() => {
    const element = document.getElementById("map-stage");
    if (!element) return;
    const zoom = Math.max(
      3,
      Math.min(
        48,
        Math.floor(
          Math.min(
            (element.clientWidth - 40) / mission.map.width,
            (element.clientHeight - 40) / mission.map.height
          )
        )
      )
    );
    setCamera({
      zoom,
      x: (element.clientWidth - mission.map.width * zoom) / 2,
      y: (element.clientHeight - mission.map.height * zoom) / 2
    });
  }, [mission.map.width, mission.map.height]);

  React.useEffect(() => {
    fitToMap();
    // Only on first mount and when the map's dimensions change.
  }, [fitToMap]);

  const enemyCount = mission.units.filter((unit) => unit.teamId !== mission.objective.teamId).length;
  const playerCount = mission.units.length - enemyCount;
  const walkable = React.useMemo(() => {
    let total = 0;
    for (const row of mission.map.terrain) {
      for (const id of row) {
        const terrain = terrainById(id);
        if (terrain && terrain.walkable) total += 1;
      }
    }
    return total;
  }, [mission.map.terrain]);

  /* ---- scene preview ----
   * Handed to the host when the editor is mounted in the game shell, so the
   * preview is the actual player rather than a lookalike. Standalone there is
   * no host, so it takes the same route Playtest does: write the slot, open
   * the game. Either way the scene is run by the game's own renderer. */
  const previewScene = React.useCallback(
    (scene, startIndex) => {
      if (typeof onScenePreview === "function") {
        onScenePreview(scene, startIndex);
        return;
      }
      writePreviewScene(scene);
      if (typeof window !== "undefined") {
        window.open("/?boot=scene&step=" + (startIndex || 0), "_blank");
      }
    },
    [onScenePreview]
  );

  /* ---- gameplay data test ----
   * The Studio has already written its draft to the slot the content registry
   * overlays at import. All that is left is to put the resolved subject into
   * the arena and open the game, which is the ordinary playtest path — the
   * battle is created by the same registry, compiler and engine as any other.
   *
   * A new tab, and therefore a fresh module graph, is not a workaround: the
   * engine's CONTENT registry is built once at import and frozen, so a draft
   * can only reach the simulation on a load that happens after it was written.
   * Keeping that property is worth a tab. */
  const testGameplayEntity = React.useCallback((request) => {
    try {
      const mission = buildArenaMission(arenaFixture, request.plan);
      localStorage.setItem(PLAYTEST_STORAGE_KEY, JSON.stringify(mission));
      window.open("/", "_blank");
    } catch (error) {
      alert("Could not open the test arena: " + error.message);
    }
  }, []);

  const chrome = (children) => (
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      <header className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        <Btn onClick={leaveEditor} title="Back to the title screen">
          ‹ Main Menu
        </Btn>
        <span className="mx-2 h-5 w-px bg-slate-700" />
        <span className="mr-3 text-[11px] font-bold uppercase tracking-[0.2em] text-sky-400">
          Status Zero · Editor
        </span>
        {/* Only working editors appear here. A mode that does not exist yet is
         *  not a tab; it is nothing. */}
        {[["mission", "Missions"], ["scene", "Scenes"], ["gameplay", "Gameplay Data"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => chooseMode(id)}
            className={
              "rounded border px-3 py-1 text-[11px] uppercase tracking-wider transition " +
              (mode === id
                ? "border-sky-400 bg-sky-900/60 text-sky-100"
                : "border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200")
            }
          >
            {label}
          </button>
        ))}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );

  if (mode === "scene") {
    return chrome(
      <React.Suspense fallback={<ModeLoading label="Loading scene editor…" />}>
        <LazySceneEditor onPreview={previewScene} previewLabel="Preview" />
      </React.Suspense>
    );
  }

  if (mode === "gameplay") {
    return chrome(
      <React.Suspense fallback={<ModeLoading label="Loading gameplay data…" />}>
        <LazyGameplayStudio onTestUnit={testGameplayEntity} />
      </React.Suspense>
    );
  }

  return chrome(
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      {/* ---- top bar ---- */}
      <header className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        <span className="mr-2 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
          Mission
        </span>
        <Btn
          onClick={() => {
            if (!confirm("Discard the current mission and start a new one?")) return;
            history.current = { past: [], future: [] };
            setMission(createEmptyMission({ width: 36, height: 48 }));
          }}
        >
          New
        </Btn>
        <Btn onClick={() => fileInput.current.click()}>Open…</Btn>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files && event.target.files[0];
            if (file) doImport(file);
            event.target.value = "";
          }}
        />
        <Btn tone="emerald" onClick={doExport}>
          Export…
        </Btn>
        <Btn tone="sky" onClick={doPlaytest} disabled={!report.ok} title={report.ok ? "" : "Fix errors first"}>
          ▶ Playtest
        </Btn>

        <div className="mx-2 h-5 w-px bg-slate-700" />
        <Btn onClick={undo} title="Ctrl+Z">
          ↶
        </Btn>
        <Btn onClick={redo} title="Ctrl+Shift+Z">
          ↷
        </Btn>
        <Btn onClick={fitToMap}>Fit</Btn>

        <div className="mx-2 h-5 w-px bg-slate-700" />
        {[
          ["Elev", showElevation, setShowElevation],
          ["Regions", showRegions, setShowRegions],
          ["Units", showUnits, setShowUnits],
          ["Grid", showGrid, setShowGrid]
        ].map(([label, value, setter]) => (
          <button
            key={label}
            onClick={() => setter((v) => !v)}
            className={
              "rounded border px-2 py-1 text-[11px] " +
              (value ? "border-sky-600 bg-sky-900/50 text-sky-200" : "border-slate-700 bg-slate-900 text-slate-500")
            }
          >
            {label}
          </button>
        ))}

        <div className="flex-1" />
        {status ? <span className="text-[11px] text-emerald-300">{status}</span> : null}
        <span className="font-mono text-[11px] text-slate-500">
          {mission.map.width}×{mission.map.height} · {playerCount}v{enemyCount} · {walkable} walkable
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- left: inspector ---- */}
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
          <nav className="flex flex-wrap gap-0.5 border-b border-slate-800 p-1.5">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setTab(entry.id)}
                className={
                  "rounded px-2 py-1 text-[11px] transition " +
                  (tab === entry.id ? "bg-sky-900/70 text-sky-100" : "text-slate-400 hover:bg-slate-800")
                }
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "mission" ? <MissionPanel mission={mission} update={update} /> : null}
            {tab === "map" ? (
              <MapPanel
                mission={mission}
                update={update}
                tool={tool}
                setTool={setTool}
                activeTerrainId={activeTerrainId}
                setActiveTerrainId={setActiveTerrainId}
                brush={brush}
                setBrush={setBrush}
                elevationDelta={elevationDelta}
                setElevationDelta={setElevationDelta}
              />
            ) : null}
            {tab === "units" ? (
              <UnitsPanel
                mission={mission}
                update={update}
                selectedUnitRef={selectedUnitRef}
                setSelectedUnitRef={setSelectedUnitRef}
                activeUnitDefinitionId={activeUnitDefinitionId}
                setActiveUnitDefinitionId={setActiveUnitDefinitionId}
                activeTeamId={activeTeamId}
                setActiveTeamId={setActiveTeamId}
                setTool={setTool}
              />
            ) : null}
            {tab === "regions" ? (
              <RegionsPanel
                mission={mission}
                update={update}
                selectedRegionId={selectedRegionId}
                setSelectedRegionId={setSelectedRegionId}
                setTool={setTool}
              />
            ) : null}
            {tab === "objective" ? <ObjectivePanel mission={mission} update={update} /> : null}
            {tab === "scenes" ? (
              <ScenesPanel
                mission={mission}
                update={update}
                selectedSceneId={selectedSceneId}
                setSelectedSceneId={setSelectedSceneId}
              />
            ) : null}
            {tab === "barks" ? (
              <BeatsPanel
                mission={mission}
                update={update}
                selectedBeatId={selectedBeatId}
                setSelectedBeatId={setSelectedBeatId}
              />
            ) : null}
            {tab === "factions" ? <FactionsPanel mission={mission} update={update} /> : null}
            {tab === "groups" ? <GroupsPanel mission={mission} update={update} /> : null}
            {tab === "objectives" ? <ObjectiveLibraryPanel mission={mission} update={update} /> : null}
            {tab === "phases" ? (
              <PhasesPanel
                mission={mission}
                update={update}
                selectedPhaseId={selectedPhaseId}
                setSelectedPhaseId={setSelectedPhaseId}
              />
            ) : null}
            {tab === "triggers" ? (
              <TriggersPanel
                mission={mission}
                update={update}
                selectedBeatId={selectedTriggerId}
                setSelectedBeatId={setSelectedTriggerId}
              />
            ) : null}
          </div>
        </aside>

        {/* ---- centre: map ---- */}
        <main id="map-stage" className="min-w-0 flex-1">
          <MapCanvas
            mission={mission}
            camera={camera}
            onCameraChange={setCamera}
            tool={tool}
            brush={brush}
            selectedUnitRef={selectedUnitRef}
            selectedRegionId={selectedRegionId}
            showElevation={showElevation}
            showRegions={showRegions}
            showUnits={showUnits}
            showGrid={showGrid}
            onPaint={onPaint}
            onPaintEnd={onPaintEnd}
            onSelectUnit={(ref) => {
              setSelectedUnitRef(ref);
              if (ref) setTab("units");
            }}
          />
        </main>

        {/* ---- right: validation + preview ---- */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
          <div className="min-h-0 flex-1">
            <ValidationPanel report={report} />
          </div>
          <ScenePreview mission={mission} selectedSceneId={selectedSceneId} />
        </aside>
      </div>
    </div>
  );
}

/** Rough approximation of how a scene reads in game — enough to catch a line
 *  that is three sentences too long for a dialogue box. */
function ScenePreview({ mission, selectedSceneId }) {
  const scene = selectedSceneId ? mission.scenes[selectedSceneId] : null;
  if (!scene) return null;
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-slate-800 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">Preview — {scene.title}</div>
      <div className="space-y-2">
        {scene.lines.map((line, index) => (
          <div key={index} className="rounded border border-slate-700 bg-slate-950/80 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-sky-400">{line.speaker}</div>
            <div className="text-[12px] leading-relaxed text-slate-200">{line.text || <em className="text-slate-600">empty</em>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

