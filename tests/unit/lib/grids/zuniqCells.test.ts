/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import { encodeZuniq } from "@/lib/grids/compactedCells.ts";
import {
  buildMixedLevelGeometry,
  buildMixedLevelTexture,
  createMixedLevelLookup,
  decodeNuniq,
  mixedLevelScheme,
  texelSize,
  toZuniqIds,
  zuniqLevels,
} from "@/lib/grids/zuniqCells.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

// level 7, cell 10974, as written by healpix-geo
const Z10974 = 386130891488886784n;

it("accepts refinement_level null with zuniq or nuniq only", () => {
  expect(
    mixedLevelScheme({ refinement_level: null, indexing_scheme: "zuniq" })
  ).toBe("zuniq");
  expect(
    mixedLevelScheme({ refinement_level: null, indexing_scheme: "nuniq" })
  ).toBe("nuniq");
});

it("rejects a refinement_level that is not null, or a scheme without levels in its ids", () => {
  for (const level of [0, 5, 29, -1, "11", undefined, NaN]) {
    expect(
      mixedLevelScheme({ refinement_level: level, indexing_scheme: "zuniq" })
    ).toBeNull();
  }
  for (const scheme of ["nested", "ring", "muniq", "", undefined, 3]) {
    expect(
      mixedLevelScheme({ refinement_level: null, indexing_scheme: scheme })
    ).toBeNull();
  }
  expect(mixedLevelScheme(null)).toBeNull();
});

it("decodes nuniq ids", () => {
  expect(decodeNuniq(4n ** 8n + 10974n)).toEqual({ level: 7, ipix: 10974n });
  expect(decodeNuniq(4n)).toEqual({ level: 0, ipix: 0n });
  expect(decodeNuniq(4n ** 30n + 5n)).toEqual({ level: 29, ipix: 5n });
  expect(() => decodeNuniq(3n)).toThrow();
  expect(() => decodeNuniq(2n * 4n ** 3n)).toThrow(); // even bit length
});

it("turns zuniq and nuniq ids into the same zuniq ids", () => {
  expect(toZuniqIds([Z10974], "zuniq")[0]).toBe(Z10974);
  expect(toZuniqIds([4n ** 8n + 10974n], "nuniq")[0]).toBe(Z10974);
  // numbers are read too
  expect(toZuniqIds([4 ** 8 + 10974], "nuniq")[0]).toBe(Z10974);
  expect(() => toZuniqIds([0n], "zuniq")).toThrow();
  expect(() => toZuniqIds([3n], "nuniq")).toThrow();
});

it("keeps ids above 2**53 whole", () => {
  const ids = [0, 1, 2].map((cell) =>
    encodeZuniq(15, BigInt(cell) + 4n ** 15n)
  );
  expect(ids.every((id) => id > 2n ** 53n)).toBe(true);
  expect([...toZuniqIds(ids, "zuniq")]).toEqual(ids);
  expect([...zuniqLevels(toZuniqIds(ids, "zuniq"))]).toEqual([15, 15, 15]);
});

it("lays one texel per cell", () => {
  expect(texelSize(5577)).toEqual({ width: 2048, height: 3 });
  expect(texelSize(10)).toEqual({ width: 10, height: 1 });
  expect(texelSize(0)).toEqual({ width: 1, height: 1 });
});

it("counts the histogram by area", () => {
  const data = Float32Array.of(1, 2, 3, NaN);
  // one level-11 cell is as large as 16 level-13 cells
  const levels = Uint8Array.of(11, 13, 13, 13);
  const { histogramSummary, dataValues } = buildMixedLevelTexture(
    data,
    levels,
    4,
    1
  );
  expect(histogramSummary.min).toBe(1);
  expect(histogramSummary.max).toBe(3);
  const bins = histogramSummary.bins;
  expect(bins[0]).toBe(16);
  expect(bins[bins.length >> 1]).toBe(1);
  expect(bins[bins.length - 1]).toBe(1);
  expect(bins.reduce((a, b) => a + b, 0)).toBe(18);
  expect(dataValues).toHaveLength(4);
});

it("builds cells of each level at their own place and finds them by point", () => {
  using grid = new Grid({ scheme: "zuniq" as never, level: 0 });
  using nested = new Grid({ scheme: "nested", level: 11 });
  const lonLat = new Float64Array([4.3, 51.2]);
  const cell11 = nested.lonLatToHealpix(lonLat)[0];
  // the level-11 cell, and a finer level-13 cell somewhere else
  const level13 = new Grid({ scheme: "nested", level: 13 });
  const other = level13.lonLatToHealpix(new Float64Array([3.0, 51.5]))[0];
  level13.free();
  const ids = BigUint64Array.of(
    encodeZuniq(11, cell11),
    encodeZuniq(13, other)
  );
  const width = 2;
  const geometry = buildMixedLevelGeometry(
    grid,
    ids,
    3,
    new ProjectionHelper("equirectangular" as never, { lat: 0, lon: 0 }),
    width,
    1
  );
  expect(geometry.positionValues).toHaveLength(2 * 9 * 3);
  expect(geometry.indices).toHaveLength(2 * 4 * 6);
  expect(Math.max(...geometry.indices)).toBe(17);
  // both vertices of one cell carry the uv of its texel
  expect(geometry.uv[0]).toBeCloseTo(0.25);
  expect(geometry.uv[2 * 9]).toBeCloseTo(0.75);

  const lookup = createMixedLevelLookup(grid, ids);
  expect(lookup.find(4.3, 51.2)).toBe(0);
  expect(lookup.find(3.0, 51.5)).toBe(1);
  expect(lookup.find(10, 10)).toBeUndefined();
  lookup.dispose();
});
