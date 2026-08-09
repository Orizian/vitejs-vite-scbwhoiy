import React from "react";
import { TERRAIN_CATALOG, terrainById, unitById } from "../content/catalog.js";

/* =========================================================================
 * MAP CANVAS
 *
 * Top-down orthogonal grid on a single <canvas>. Top-down rather than
 * isometric on purpose: authoring is far more accurate on a square grid, and
 * the game's own projection is derived from the same (x, y) — +y is toward
 * the bottom of the editor and toward the camera in game.
 *
 * Canvas rather than DOM because an XL map is 64x80 = 5,120 tiles, and 5,120
 * divs re-styling on every brush stroke is not a tool anyone can draw with.
 * =======================================================================*/

const TEAM_COLORS = {
  player: "#34d399",
  foe: "#fb7185",
  neutral: "#fbbf24"
};

export default function MapCanvas({
  mission,
  camera,
  onCameraChange,
  tool,
  brush,
  selectedUnitRef,
  selectedRegionId,
  showElevation,
  showRegions,
  showUnits,
  showGrid,
  onPaint,
  onPaintEnd,
  onSelectUnit,
  onHoverTile
}) {
  const canvasRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const [size, setSize] = React.useState({ width: 800, height: 600 });
  const [hover, setHover] = React.useState(null);
  const dragRef = React.useRef(null);

  const tile = camera.zoom;
  const map = mission.map;

  /* ---- keep the canvas the size of its container ---- */
  React.useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const screenToTile = React.useCallback(
    (clientX, clientY) => {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = Math.floor((clientX - rect.left - camera.x) / tile);
      const y = Math.floor((clientY - rect.top - camera.y) / tile);
      return { x, y };
    },
    [camera.x, camera.y, tile]
  );

  /* ---- render ---- */
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = size.width + "px";
    canvas.style.height = size.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = "#05080f";
    ctx.fillRect(0, 0, size.width, size.height);

    ctx.save();
    ctx.translate(camera.x, camera.y);

    // Only draw the tiles actually on screen. This is what keeps an XL map
    // responsive while dragging a brush across it.
    const x0 = Math.max(0, Math.floor(-camera.x / tile));
    const y0 = Math.max(0, Math.floor(-camera.y / tile));
    const x1 = Math.min(map.width, Math.ceil((-camera.x + size.width) / tile) + 1);
    const y1 = Math.min(map.height, Math.ceil((-camera.y + size.height) / tile) + 1);

    const maxElevation = Math.max(1, ...map.elevation.flat());

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const terrain = terrainById(map.terrain[y][x]);
        ctx.fillStyle = terrain ? terrain.paint : "#ff00ff";
        ctx.fillRect(x * tile, y * tile, tile, tile);

        const level = map.elevation[y][x];
        if (level > 0) {
          // Higher ground reads brighter. Same idea as the in-game elevation
          // overlay so a map looks familiar when you first load it.
          ctx.fillStyle = "rgba(226,232,240," + (0.06 + 0.14 * (level / maxElevation)).toFixed(3) + ")";
          ctx.fillRect(x * tile, y * tile, tile, tile);
        }
      }
    }

    /* elevation numbers */
    if (showElevation && tile >= 14) {
      ctx.font = Math.floor(tile * 0.42) + "px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const level = map.elevation[y][x];
          if (!level) continue;
          ctx.fillStyle = "rgba(226,232,240,0.75)";
          ctx.fillText(String(level), x * tile + tile / 2, y * tile + tile / 2);
        }
      }
    }

    /* cliff warnings: steps a unit cannot climb (default limit is 1 level) */
    ctx.strokeStyle = "rgba(248,113,113,0.9)";
    ctx.lineWidth = Math.max(1.5, tile * 0.09);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const terrain = terrainById(map.terrain[y][x]);
        if (!terrain || !terrain.walkable) continue;
        const here = map.elevation[y][x];
        if (x + 1 < map.width) {
          const next = terrainById(map.terrain[y][x + 1]);
          if (next && next.walkable && Math.abs(map.elevation[y][x + 1] - here) > 1) {
            ctx.beginPath();
            ctx.moveTo((x + 1) * tile, y * tile);
            ctx.lineTo((x + 1) * tile, (y + 1) * tile);
            ctx.stroke();
          }
        }
        if (y + 1 < map.height) {
          const next = terrainById(map.terrain[y + 1][x]);
          if (next && next.walkable && Math.abs(map.elevation[y + 1][x] - here) > 1) {
            ctx.beginPath();
            ctx.moveTo(x * tile, (y + 1) * tile);
            ctx.lineTo((x + 1) * tile, (y + 1) * tile);
            ctx.stroke();
          }
        }
      }
    }

    /* grid */
    if (showGrid && tile >= 6) {
      ctx.strokeStyle = "rgba(148,163,184,0.13)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 1) {
        ctx.moveTo(x * tile + 0.5, y0 * tile);
        ctx.lineTo(x * tile + 0.5, y1 * tile);
      }
      for (let y = y0; y <= y1; y += 1) {
        ctx.moveTo(x0 * tile, y * tile + 0.5);
        ctx.lineTo(x1 * tile, y * tile + 0.5);
      }
      ctx.stroke();

      // Every 10th line heavier, so you can count tiles without a ruler.
      ctx.strokeStyle = "rgba(148,163,184,0.3)";
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 1) {
        if (x % 10) continue;
        ctx.moveTo(x * tile + 0.5, y0 * tile);
        ctx.lineTo(x * tile + 0.5, y1 * tile);
      }
      for (let y = y0; y <= y1; y += 1) {
        if (y % 10) continue;
        ctx.moveTo(x0 * tile, y * tile + 0.5);
        ctx.lineTo(x1 * tile, y * tile + 0.5);
      }
      ctx.stroke();
    }

    /* regions */
    if (showRegions) {
      for (const region of mission.regions) {
        const selected = region.id === selectedRegionId;
        ctx.fillStyle = hexToRgba(region.color, selected ? 0.38 : 0.2);
        for (const t of region.tiles) {
          if (t.x < x0 - 1 || t.x > x1 || t.y < y0 - 1 || t.y > y1) continue;
          ctx.fillRect(t.x * tile, t.y * tile, tile, tile);
        }
        if (selected) {
          ctx.strokeStyle = region.color;
          ctx.lineWidth = 2;
          for (const t of region.tiles) {
            if (t.x < x0 - 1 || t.x > x1 || t.y < y0 - 1 || t.y > y1) continue;
            ctx.strokeRect(t.x * tile + 1, t.y * tile + 1, tile - 2, tile - 2);
          }
        }
      }
    }

    /* units */
    if (showUnits) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const unit of mission.units) {
        if (unit.x < x0 - 1 || unit.x > x1 || unit.y < y0 - 1 || unit.y > y1) continue;
        const cx = unit.x * tile + tile / 2;
        const cy = unit.y * tile + tile / 2;
        const color = TEAM_COLORS[unit.teamId] || "#c4b5fd";
        const selected = unit.ref === selectedUnitRef;

        ctx.beginPath();
        ctx.arc(cx, cy, tile * 0.38, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(2,6,12,0.82)";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 3 : 1.6;
        ctx.stroke();

        const definition = unitById(unit.definitionId);
        if (tile >= 12) {
          ctx.fillStyle = color;
          ctx.font = "bold " + Math.floor(tile * 0.5) + "px ui-monospace, monospace";
          ctx.fillText(definition ? definition.glyph : "?", cx, cy + 1);
        }

        if (unit.facing && tile >= 14) {
          const vector = FACING_VECTORS[unit.facing];
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + vector[0] * tile * 0.46, cy + vector[1] * tile * 0.46);
          ctx.stroke();
        }

        if (selected) {
          ctx.strokeStyle = "#fef08a";
          ctx.lineWidth = 2;
          ctx.strokeRect(unit.x * tile + 1, unit.y * tile + 1, tile - 2, tile - 2);
        }
      }
    }

    /* hover + brush preview */
    if (hover && hover.x >= 0 && hover.y >= 0 && hover.x < map.width && hover.y < map.height) {
      const radius = tool === "unit" || tool === "select" ? 0 : brush - 1;
      ctx.strokeStyle = "rgba(250,250,250,0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        (hover.x - radius) * tile + 0.5,
        (hover.y - radius) * tile + 0.5,
        tile * (radius * 2 + 1) - 1,
        tile * (radius * 2 + 1) - 1
      );
    }

    ctx.restore();
  }, [
    mission,
    camera,
    size,
    tile,
    hover,
    brush,
    tool,
    selectedUnitRef,
    selectedRegionId,
    showElevation,
    showRegions,
    showUnits,
    showGrid,
    map
  ]);

  /* ---- interaction ---- */
  const applyAt = React.useCallback(
    (clientX, clientY, phase) => {
      const point = screenToTile(clientX, clientY);
      if (point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height) return;
      onPaint(point, phase);
    },
    [screenToTile, map.width, map.height, onPaint]
  );

  const onPointerDown = (event) => {
    canvasRef.current.setPointerCapture(event.pointerId);
    // Middle button or space-less right button pans; everything else draws.
    if (event.button === 1 || event.button === 2) {
      dragRef.current = { mode: "pan", x: event.clientX, y: event.clientY, camera };
      return;
    }
    const point = screenToTile(event.clientX, event.clientY);
    if (tool === "select") {
      const unit = mission.units.find((entry) => entry.x === point.x && entry.y === point.y);
      onSelectUnit(unit ? unit.ref : null);
      return;
    }
    dragRef.current = { mode: "paint" };
    applyAt(event.clientX, event.clientY, "start");
  };

  const onPointerMove = (event) => {
    const point = screenToTile(event.clientX, event.clientY);
    setHover(point);
    if (onHoverTile) {
      const inside = point.x >= 0 && point.y >= 0 && point.x < map.width && point.y < map.height;
      onHoverTile(inside ? point : null);
    }
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      onCameraChange({
        ...camera,
        x: drag.camera.x + (event.clientX - drag.x),
        y: drag.camera.y + (event.clientY - drag.y)
      });
      return;
    }
    applyAt(event.clientX, event.clientY, "move");
  };

  const endDrag = () => {
    if (dragRef.current && dragRef.current.mode === "paint" && onPaintEnd) onPaintEnd();
    dragRef.current = null;
  };

  const onWheel = (event) => {
    event.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const worldX = (px - camera.x) / camera.zoom;
    const worldY = (py - camera.y) / camera.zoom;
    const next = clamp(3, 64, camera.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    onCameraChange({ zoom: next, x: px - worldX * next, y: py - worldY * next });
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-[#05080f]">
      <canvas
        ref={canvasRef}
        className="block touch-none"
        style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          setHover(null);
          if (onHoverTile) onHoverTile(null);
        }}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      {hover && hover.x >= 0 && hover.y >= 0 && hover.x < map.width && hover.y < map.height ? (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-slate-950/90 px-2 py-1 font-mono text-[11px] text-slate-300 ring-1 ring-slate-700">
          {hover.x},{hover.y} · {map.terrain[hover.y][hover.x]} · elev {map.elevation[hover.y][hover.x]}
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-slate-950/90 px-2 py-1 font-mono text-[11px] text-slate-400 ring-1 ring-slate-700">
        {map.width}×{map.height} · drag with right/middle button to pan · wheel to zoom
      </div>
    </div>
  );
}

const FACING_VECTORS = {
  northeast: [0.7, -0.7],
  southeast: [0.7, 0.7],
  southwest: [-0.7, 0.7],
  northwest: [-0.7, -0.7]
};

function clamp(min, max, value) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

export { TERRAIN_CATALOG, TEAM_COLORS };
