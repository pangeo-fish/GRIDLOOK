/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";

import { indexFromZarr } from "@/lib/data/sourceIndexing.ts";
import {
  nearestPointIndex,
  pointsInRange,
  seriesPoints,
  timeSeriesCoordinate,
  timeSeriesNames,
  timeTicks,
} from "@/lib/data/timeSeries.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

function source(dimensionNames: string[], attrs = {}): TDataSource {
  return { store: "s", dataset: "", attrs: { ...attrs, dimensionNames } };
}

const TIME = { units: "seconds since 1970-01-01" };
const HOUR = 3600000;
const DAY = 24 * HOUR;

it("finds the variables with one dimension along a time coordinate", () => {
  const datasources = {
    time: source(["time"], TIME),
    tagTime: source(["tagTime"], TIME),
    cells: source(["cells"]),
    posterior: source(["time", "cells"]),
    marker: source(["cells"]),
    tagTemperature: source(["tagTime"], { units: "degC" }),
    mean: source(["time"]),
    // a duration, not a time: no "since"
    lead: source(["lead"], { units: "hours" }),
    spread: source(["lead"]),
    "group/series": source(["time"]),
    "group/time": source(["time"], TIME),
  };
  expect(timeSeriesCoordinate("tagTemperature", datasources)).toBe("tagTime");
  expect(timeSeriesNames(datasources)).toEqual([
    "tagTemperature",
    "mean",
    "group/series",
  ]);
});

it("leaves out the variables that are times themselves", () => {
  const datasources = {
    timeCounter: source(["timeCounter"], TIME),
    timeCentered: source(["timeCounter"], TIME),
    referenceTime: source(["timeCounter"], { units: "hours since 2000-01-01" }),
    mean: source(["timeCounter"]),
  };
  expect(timeSeriesNames(datasources)).toEqual(["mean"]);
});

it("leaves out the variables of a trajectory", () => {
  const datasources = {
    time: source(["time"], TIME),
    lat: source(["time"], { units: "degrees_north" }),
    lon: source(["time"], { units: "degrees_east" }),
    temperature: source(["time"]),
    tagTime: source(["tagTime"], TIME),
    depth: source(["tagTime"]),
  };
  expect(timeSeriesNames(datasources)).toEqual(["depth"]);
});

it("hides the time series from the variables of an indexed store", async () => {
  const arrays: Record<string, [string[], Record<string, string>]> = {
    time: [["time"], TIME],
    tag_time: [["tag_time"], TIME],
    cells: [["cells"], {}],
    posterior: [["time", "cells"], {}],
    tag_depth: [["tag_time"], { units: "m" }],
  };
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": {},
  };
  for (const [name, [dimensions, attrs]] of Object.entries(arrays)) {
    metadata[`${name}/.zarray`] = {
      zarr_format: 2,
      shape: dimensions.map(() => 1),
      chunks: dimensions.map(() => 1),
      dtype: "<f4",
      compressor: null,
      filters: null,
      fill_value: 0,
      order: "C",
    };
    metadata[`${name}/.zattrs`] = { ...attrs, _ARRAY_DIMENSIONS: dimensions };
  }
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ zarr_consolidated_format: 1, metadata }))
    );
  try {
    const index = await indexFromZarr("https://example.test/tag.zarr");
    const sources = index.levels[0].datasources;
    expect(sources.posterior.hidden).toBe(false);
    expect(sources.tag_depth.hidden).toBe(true);
  } finally {
    fetchMock.mockRestore();
  }
});

it("sorts the points by time and drops those without a time", () => {
  expect(seriesPoints([0, 10, 20], [1, 2, 3])).toEqual([
    { x: 0, y: 1 },
    { x: 10, y: 2 },
    { x: 20, y: 3 },
  ]);
  expect(seriesPoints([30, NaN, 10, 20], [1, 2, 3, 4])).toEqual([
    { x: 10, y: 3 },
    { x: 20, y: 4 },
    { x: 30, y: 1 },
  ]);
});

it("finds the point nearest to a time", () => {
  const points = [0, 10, 20, 40].map((x) => ({ x, y: 0 }));
  expect(nearestPointIndex(points, -5)).toBe(0);
  expect(nearestPointIndex(points, 14)).toBe(1);
  expect(nearestPointIndex(points, 16)).toBe(2);
  expect(nearestPointIndex(points, 31)).toBe(3);
  expect(nearestPointIndex(points, 99)).toBe(3);
  expect(nearestPointIndex([{ x: 3, y: 0 }], 99)).toBe(0);
  expect(nearestPointIndex([], 99)).toBe(0);
});

it("keeps the points of a period and one on each side", () => {
  const points = [0, 10, 20, 30, 40].map((x) => ({ x, y: 0 }));
  const times = (min: number, max: number) =>
    pointsInRange(points, min, max).map((point) => point.x);
  expect(times(12, 28)).toEqual([10, 20, 30]);
  expect(times(10, 30)).toEqual([0, 10, 20, 30]);
  expect(times(-5, 99)).toEqual([0, 10, 20, 30, 40]);
  expect(times(50, 60)).toEqual([40]);
});

it("puts the ticks of a time axis at round hours or days", () => {
  // half a day: every 3 hours
  const hours = timeTicks(6 * HOUR, 18 * HOUR);
  expect(hours.step).toBe(3 * HOUR);
  expect(hours.ticks.map((tick) => tick.value / HOUR)).toEqual([
    6, 9, 12, 15, 18,
  ]);
  // 5 days from 13:00: every 2 days, at midnight
  const days = timeTicks(13 * HOUR, 13 * HOUR + 5 * DAY);
  expect(days.step).toBe(2 * DAY);
  expect(days.ticks.map((tick) => tick.value / DAY)).toEqual([2, 4]);
  // more than a year: never more than 5 ticks
  const year = timeTicks(0, 466 * DAY);
  expect(year.ticks.length).toBeLessThanOrEqual(5);
  expect(year.ticks.every((tick) => tick.value % DAY === 0)).toBe(true);
});
