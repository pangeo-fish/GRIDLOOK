import { expect, it } from "vitest";

import {
  nearestPointIndex,
  timeSeriesCoordinate,
  timeSeriesNames,
} from "@/lib/data/timeSeries.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

function source(dimensionNames: string[], attrs = {}): TDataSource {
  return { store: "s", dataset: "", attrs: { ...attrs, dimensionNames } };
}

const TIME = { units: "seconds since 1970-01-01" };

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

it("finds the point nearest to a time", () => {
  const points = [0, 10, 20, 40].map((x) => ({ x, y: 0 }));
  expect(nearestPointIndex(points, -5)).toBe(0);
  expect(nearestPointIndex(points, 14)).toBe(1);
  expect(nearestPointIndex(points, 16)).toBe(2);
  expect(nearestPointIndex(points, 31)).toBe(3);
  expect(nearestPointIndex(points, 99)).toBe(3);
  expect(nearestPointIndex([{ x: 3, y: 0 }], 99)).toBe(0);
});
