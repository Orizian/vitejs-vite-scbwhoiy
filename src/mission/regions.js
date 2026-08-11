/* =========================================================================
 * REGIONS
 *
 * What it means for a tile to be inside an authored region.
 *
 * The answer is the obvious one — the region's tiles are the region — and this
 * module exists so that there is exactly one place that says so. There used to
 * be two: objectives tested the authored tile list, while the mid-battle
 * trigger tested the region's *bounding box*, which is the same answer only
 * for rectangles. An L-shaped region reported units standing in the notch as
 * being inside it, and the mission validator carried a standing warning saying
 * as much rather than fixing it.
 *
 * That was survivable while regions only decorated dialogue. It stops being
 * survivable the moment standing on a tile can hurt you: a hazard that fires
 * in a corner nobody authored is not a bug a player can reason about.
 *
 * Pure data and pure functions. No engine, no React, no content ids.
 * =======================================================================*/

/** One tile's key in a membership index. */
export function tileKeyOf(x, y) {
  return x + "," + y;
}

/**
 * An O(1) membership index over a tile list.
 *
 * Worth building whenever the same region is tested more than once — a
 * movement path, a list of units, a fixture sweep. For a single test,
 * `regionContains` is cheaper.
 */
export function createTileIndex(tiles) {
  const index = new Set();
  for (const tile of tiles || []) index.add(tileKeyOf(tile.x, tile.y));
  return index;
}

/** Whether a tile list contains a tile. Exact; never an approximation. */
export function regionContains(tiles, x, y) {
  for (const tile of tiles || []) {
    if (tile.x === x && tile.y === y) return true;
  }
  return false;
}

/** Whether any tile of a path lies inside the tile list. */
export function pathEntersRegion(tiles, path) {
  const index = createTileIndex(tiles);
  for (const step of path || []) {
    if (index.has(tileKeyOf(step.x, step.y))) return true;
  }
  return false;
}

/**
 * The smallest rectangle covering a tile list.
 *
 * Still useful — framing a camera, sizing a minimap crop, deciding roughly
 * where a region is. It is deliberately *not* used for membership, and the
 * name says which of the two it is so the next person does not have to guess.
 */
export function boundingBoxOf(tiles) {
  if (!tiles || !tiles.length) return { xMin: 0, xMax: -1, yMin: 0, yMax: -1 };
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const tile of tiles) {
    if (tile.x < xMin) xMin = tile.x;
    if (tile.x > xMax) xMax = tile.x;
    if (tile.y < yMin) yMin = tile.y;
    if (tile.y > yMax) yMax = tile.y;
  }
  return { xMin, xMax, yMin, yMax };
}

/** Whether a tile list is exactly its own bounding box — i.e. a full rectangle. */
export function isRectangular(tiles) {
  if (!tiles || !tiles.length) return true;
  const box = boundingBoxOf(tiles);
  const width = box.xMax - box.xMin + 1;
  const height = box.yMax - box.yMin + 1;
  return createTileIndex(tiles).size === width * height;
}
