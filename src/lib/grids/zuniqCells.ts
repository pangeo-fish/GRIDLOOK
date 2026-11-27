import type { Grid } from "healpix-geo";

import { decodeZuniq, encodeZuniq } from "./compactedCells.ts";
import { generateHealpixIndices } from "./healpixCalculations.ts";

import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  type THistogramSummary,
} from "@/utils/histogram.ts";

/**
 * How far a patch grows past its cell, as a fraction of the cell, so that
 * neighbouring patches overlap by a hair: the corners they share are
 * computed apart and can differ by a float32 step, which leaves a gap of a
 * pixel at most where the patches should meet.
 */
const PATCH_OVERLAP = 1e-3;

export type TMixedScheme = "zuniq" | "nuniq";

/**
 * Whether the `dggs` metadata describes cells of mixed levels: a
 * `refinement_level` of `null` together with a scheme that holds the level in
 * the cell ids. Only `zuniq` and `nuniq` are read; anything else, including a
 * `null` level of another scheme or an integer level, is not mixed.
 */
export function mixedLevelScheme(
  metadata: { refinement_level?: unknown; indexing_scheme?: unknown } | null
): TMixedScheme | null {
  if (metadata?.refinement_level !== null) {
    return null;
  }
  const scheme = metadata.indexing_scheme;
  return scheme === "zuniq" || scheme === "nuniq" ? scheme : null;
}

/** The level and the nested id of a `nuniq` id: `4 ** (level + 1) + ipix`. */
export function decodeNuniq(id: bigint) {
  if (id < 4n) {
    throw new Error(`Not a nuniq cell id: ${id}`);
  }
  const bits = id.toString(2).length;
  if (bits % 2 !== 1) {
    throw new Error(`Not a nuniq cell id: ${id}`);
  }
  const level = (bits - 1) / 2 - 1;
  return { level, ipix: id - 4n ** BigInt(level + 1) };
}

/** The cells of a coordinate as `zuniq` ids, the form the grid draws. */
export function toZuniqIds(
  ids: ArrayLike<number | bigint>,
  scheme: TMixedScheme
) {
  const zuniq = new BigUint64Array(ids.length);
  for (let at = 0; at < ids.length; at++) {
    const id = BigInt(ids[at]);
    if (scheme === "zuniq") {
      decodeZuniq(id); // throws on an id that is not a zuniq id
      zuniq[at] = id;
    } else {
      const cell = decodeNuniq(id);
      zuniq[at] = encodeZuniq(cell.level, cell.ipix);
    }
  }
  return zuniq;
}

/** The level of every `zuniq` id. */
export function zuniqLevels(ids: BigUint64Array) {
  return Uint8Array.from(ids, (id) => decodeZuniq(id).level);
}

/** The distinct levels of `ids`, ascending. */
export function distinctLevels(levels: Uint8Array) {
  return [...new Set(levels)].sort((a, b) => a - b);
}

/** Cell `i` of `n` sits at the centre of texel `i` of a `width`-wide texture. */
export function texelSize(count: number, maxWidth = 2048) {
  const width = Math.max(1, Math.min(count, maxWidth));
  return { width, height: Math.max(1, Math.ceil(count / width)) };
}

/** The vertices (longitude, latitude pairs) grown about their centre. */
export function overlapped(coords: Float64Array, grow = PATCH_OVERLAP) {
  const count = coords.length / 2;
  // longitudes relative to the first vertex, so that a cell on the date line
  // is not torn apart
  const lon0 = coords[0];
  const relative = (lon: number) => ((lon - lon0 + 540) % 360) - 180;
  let centreLon = 0;
  let centreLat = 0;
  for (let at = 0; at < count; at++) {
    centreLon += relative(coords[2 * at]) / count;
    centreLat += coords[2 * at + 1] / count;
  }
  const grown = new Float64Array(coords.length);
  for (let at = 0; at < count; at++) {
    const lon =
      lon0 + centreLon + (relative(coords[2 * at]) - centreLon) * (1 + grow);
    grown[2 * at] = ((lon + 540) % 360) - 180;
    // a vertex at a pole must not be pushed past it
    grown[2 * at + 1] = Math.max(
      -90,
      Math.min(90, centreLat + (coords[2 * at + 1] - centreLat) * (1 + grow))
    );
  }
  return grown;
}

/**
 * One `steps` x `steps` patch per cell, each cell at its own level. Every
 * vertex of a cell carries the uv of the cell's texel, so that the cell takes
 * one value from the texture.
 */
export function buildMixedLevelGeometry(
  grid: Grid,
  ids: BigUint64Array,
  steps: number,
  helper: ProjectionHelper,
  width: number,
  height: number
) {
  const perCell = steps * steps;
  const positionValues = new Float32Array(ids.length * perCell * 3);
  const uv = new Float32Array(ids.length * perCell * 2);
  const latLonValues = new Float32Array(ids.length * perCell * 2);
  const indices = new Uint32Array(ids.length * (steps - 1) ** 2 * 6);
  for (let cell = 0; cell < ids.length; cell++) {
    const coords = overlapped(grid.vertices(ids[cell], steps));
    const u = ((cell % width) + 0.5) / width;
    const v = (Math.floor(cell / width) + 0.5) / height;
    for (let at = 0; at < perCell; at++) {
      const vertex = cell * perCell + at;
      helper.projectLatLonToArrays(
        coords[2 * at + 1],
        coords[2 * at],
        positionValues,
        vertex * 3,
        latLonValues,
        vertex * 2
      );
      uv[vertex * 2] = u;
      uv[vertex * 2 + 1] = v;
    }
    const patch = generateHealpixIndices(
      positionValues.subarray(cell * perCell * 3, (cell + 1) * perCell * 3),
      steps
    );
    for (let at = 0; at < patch.length; at++) {
      indices[cell * patch.length + at] = cell * perCell + patch[at];
    }
  }
  return { positionValues, uv, latLonValues, indices };
}

/**
 * The values as a texture with one texel per cell, and their histogram with
 * every cell counted by its area (a cell of a coarser level counts four times
 * a cell one level finer).
 */
export function buildMixedLevelTexture(
  data: Float32Array,
  levels: Uint8Array,
  width: number,
  height: number
) {
  const dataValues = new Float32Array(width * height).fill(NaN);
  dataValues.set(data);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of data) {
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  const finest = levels.reduce((a, b) => Math.max(a, b), 0);
  // area weights sum past 2**32 for a few cells of level 5 next to level 15:
  // add up in doubles, then scale into the uint32 bins
  const weighted = new Float64Array(HISTOGRAM_SUMMARY_BINS);
  if (Number.isFinite(min)) {
    const binSize = (max - min) / weighted.length;
    for (let at = 0; at < data.length; at++) {
      if (!Number.isFinite(data[at])) {
        continue;
      }
      const bin =
        max === min
          ? weighted.length >> 1
          : Math.min(
              weighted.length - 1,
              Math.floor((data[at] - min) / binSize)
            );
      weighted[bin] += 4 ** (finest - levels[at]);
    }
  } else {
    min = max = NaN;
  }
  const heaviest = weighted.reduce((a, b) => Math.max(a, b), 0);
  const scale = heaviest > 0xffffffff ? 0xffffffff / heaviest : 1;
  const bins = Uint32Array.from(weighted, (weight) =>
    Math.round(weight * scale)
  );
  const histogramSummary: THistogramSummary = { bins, min, max };
  return {
    dataValues,
    width,
    height,
    dataRect: { u: 0, v: 0, width: 1, height: 1 },
    histogramSummary,
  };
}

/**
 * The index of the cell at a point: the point's cell of every level that the
 * data has, looked up by id.
 */
export function createMixedLevelLookup(grid: Grid, ids: BigUint64Array) {
  const index = new Map<bigint, number>();
  ids.forEach((id, at) => index.set(id, at));
  const grids = distinctLevels(zuniqLevels(ids)).map((level) =>
    grid.replace({ level })
  );
  return {
    find(lon: number, lat: number) {
      const point = new Float64Array([lon, lat]);
      for (const levelGrid of grids) {
        const at = index.get(levelGrid.lonLatToHealpix(point)[0]);
        if (at !== undefined) {
          return at;
        }
      }
      return undefined;
    },
    dispose() {
      grids.forEach((levelGrid) => levelGrid.free());
    },
  };
}
