import {
  isLatitudeVariable,
  isLongitudeVariable,
} from "./coordinateVariables.ts";
import { currentLevel } from "./levels.ts";
import { decodeTime, isTimeUnits } from "./timeHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";

export type TTimeSeriesPoint = {
  // epoch milliseconds
  x: number;
  y: number;
};

export type TTimeSeries = {
  name: string;
  label: string;
  units?: string;
  // CF `positive: down` (a depth): the value axis points down
  reversed: boolean;
  // sorted by time
  points: TTimeSeriesPoint[];
};

function soleDimension(varname: string, source: TDataSource | undefined) {
  const dimensions = source?.attrs?.dimensionNames;
  return Array.isArray(dimensions) && dimensions.length === 1
    ? ZarrDataManager.resolveVariablePath(varname, String(dimensions[0]))
    : undefined;
}

/**
 * The time coordinate of a variable that is a time series: a variable with
 * one dimension whose coordinate (another array of the dataset) has CF time
 * units, e.g. the record of a tag next to the maps of its position. Such a
 * variable has no cells to draw; it is plotted against time instead. The
 * coordinate need not be the `time` of the maps. A variable that is a time
 * itself (the centre of an averaging period, a forecast reference time) is
 * not a record.
 */
export function timeSeriesCoordinate(
  varname: string,
  datasources: Record<string, TDataSource>
): string | undefined {
  const source = datasources[varname];
  const coordinate = soleDimension(varname, source);
  if (
    coordinate === undefined ||
    coordinate === varname ||
    source.dtype === "string" ||
    isTimeUnits(source.attrs?.units)
  ) {
    return undefined;
  }
  return isTimeUnits(datasources[coordinate]?.attrs?.units)
    ? coordinate
    : undefined;
}

/**
 * The time series of a dataset. Variables along a time coordinate that
 * positions run along too (a trajectory: `lat(time)`, `lon(time)`) are left
 * out: those are drawn on the globe.
 */
export function timeSeriesNames(datasources: Record<string, TDataSource>) {
  const trajectories = new Set<string>();
  for (const [varname, source] of Object.entries(datasources)) {
    const dimension = soleDimension(varname, source);
    if (
      dimension !== undefined &&
      (isLatitudeVariable(varname, source.attrs) ||
        isLongitudeVariable(varname, source.attrs))
    ) {
      trajectories.add(dimension);
    }
  }
  return Object.keys(datasources).filter((varname) => {
    const coordinate = timeSeriesCoordinate(varname, datasources);
    return coordinate !== undefined && !trajectories.has(coordinate);
  });
}

/** A time series has no cells to draw: it is not offered for the globe. */
export function hideTimeSeries(datasources: Record<string, TDataSource>) {
  for (const varname of timeSeriesNames(datasources)) {
    datasources[varname].hidden = true;
  }
}

/** The points of a series by time, without those whose time is missing. */
export function seriesPoints(
  times: ArrayLike<number>,
  values: ArrayLike<number>
) {
  const points: TTimeSeriesPoint[] = [];
  let sorted = true;
  for (let i = 0; i < times.length; i++) {
    if (Number.isNaN(times[i])) {
      continue;
    }
    sorted &&= points.length === 0 || times[i] >= points[points.length - 1].x;
    points.push({ x: times[i], y: values[i] });
  }
  return sorted ? points : points.sort((a, b) => a.x - b.x);
}

// ponytail: the whole record is read at once and kept as {x, y} objects
// (some tens of MB for 670 000 points); the ceiling is the memory of the
// tab. Upgrade path: read only the chunks of the period shown.
export async function loadTimeSeries(
  datasources: TSources,
  varname: string
): Promise<TTimeSeries> {
  const sources = currentLevel(datasources).datasources;
  const coordinate = timeSeriesCoordinate(varname, sources);
  if (!coordinate) {
    throw new Error(`${varname} is not a time series`);
  }
  const format = datasources.zarr_format;
  const [datavar, timevar] = await Promise.all([
    ZarrDataManager.getVariableInfo(sources[varname], varname, format),
    ZarrDataManager.getVariableInfo(sources[coordinate], coordinate, format),
  ]);
  const [values, times] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(datavar),
    ZarrDataManager.getVariableDataFromArray(timevar),
  ]);
  const y = castDataVarToFloat32(values.data as never);
  decodeVariableDataAndGetBounds(datavar, y);
  const t = times.data as ArrayLike<number | bigint>;
  const x = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    x[i] = decodeTime(t[i], timevar.attrs).valueOf();
  }
  const attrs = datavar.attrs;
  return {
    name: varname,
    label: String(attrs.long_name ?? attrs.standard_name ?? varname),
    units: typeof attrs.units === "string" ? attrs.units : undefined,
    reversed: String(attrs.positive).toLowerCase() === "down",
    points: seriesPoints(x, y),
  };
}

/** Index of the first point at or after a time (the length if none). */
function lowerBound(points: TTimeSeriesPoint[], time: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].x < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Index of the point nearest to a time (0 for an empty series). */
export function nearestPointIndex(
  points: TTimeSeriesPoint[],
  time: number
): number {
  const after = lowerBound(points, time);
  if (after === 0 || after === points.length) {
    return Math.max(0, after - 1);
  }
  return time - points[after - 1].x <= points[after].x - time
    ? after - 1
    : after;
}

/**
 * The points from the last one before `min` to the first one after `max`,
 * so that the line reaches both edges of the period.
 */
export function pointsInRange(
  points: TTimeSeriesPoint[],
  min: number,
  max: number
) {
  return points.slice(
    Math.max(0, lowerBound(points, min) - 1),
    lowerBound(points, max) + 1
  );
}

const HOUR = 3600000;
// hours between two ticks: hours up to a day, then whole days
const TICK_HOURS = [1, 2, 3, 6, 12, 24, 48, 120, 240, 720, 1440, 2880, 8760];

/**
 * Ticks of a time axis at round UTC hours or days: at most `maxCount` of
 * them (more only past `maxCount` years), with the step between them in
 * milliseconds.
 */
export function timeTicks(min: number, max: number, maxCount = 5) {
  let step = TICK_HOURS[TICK_HOURS.length - 1] * HOUR;
  for (const hours of TICK_HOURS) {
    if ((max - min) / (hours * HOUR) < maxCount) {
      step = hours * HOUR;
      break;
    }
  }
  const ticks: { value: number }[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push({ value });
  }
  return { step, ticks };
}
