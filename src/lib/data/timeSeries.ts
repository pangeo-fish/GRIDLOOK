import { currentLevel } from "./levels.ts";
import { decodeTime, isTimeUnits } from "./timeHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";

export type TTimeSeries = {
  name: string;
  label: string;
  units?: string;
  // CF `positive: down` (a depth): the value axis points down
  reversed: boolean;
  // x: epoch milliseconds, in the order of the store
  points: { x: number; y: number }[];
};

/**
 * The time coordinate of a variable that is a time series: a variable with
 * one dimension whose coordinate (another array of the dataset) has CF time
 * units, e.g. the record of a tag next to the maps of its position. Such a
 * variable has no cells to draw; it is plotted against time instead. The
 * coordinate need not be the `time` of the maps.
 */
export function timeSeriesCoordinate(
  varname: string,
  datasources: Record<string, TDataSource>
): string | undefined {
  const source = datasources[varname];
  const dimensions = source?.attrs?.dimensionNames;
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 1 ||
    source.dtype === "string"
  ) {
    return undefined;
  }
  const coordinate = ZarrDataManager.resolveVariablePath(
    varname,
    String(dimensions[0])
  );
  if (coordinate === varname) {
    return undefined;
  }
  return isTimeUnits(datasources[coordinate]?.attrs?.units)
    ? coordinate
    : undefined;
}

export function timeSeriesNames(datasources: Record<string, TDataSource>) {
  return Object.keys(datasources).filter((varname) =>
    timeSeriesCoordinate(varname, datasources)
  );
}

export async function loadTimeSeries(
  datasources: TSources,
  varname: string
): Promise<TTimeSeries> {
  const sources = currentLevel(datasources).datasources;
  const coordinate = timeSeriesCoordinate(varname, sources);
  if (!coordinate) {
    throw new Error(`${varname} is not a time series`);
  }
  const [datavar, timevar] = await Promise.all([
    ZarrDataManager.getVariableInfo(sources[varname], varname),
    ZarrDataManager.getVariableInfo(sources[coordinate], coordinate),
  ]);
  const [values, times] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(datavar),
    ZarrDataManager.getVariableDataFromArray(timevar),
  ]);
  const y = castDataVarToFloat32(values.data as never);
  decodeVariableDataAndGetBounds(datavar, y);
  const t = times.data as ArrayLike<number | bigint>;
  const points: TTimeSeries["points"] = [];
  for (let i = 0; i < y.length; i++) {
    points.push({ x: decodeTime(t[i], timevar.attrs).valueOf(), y: y[i] });
  }
  const attrs = datavar.attrs;
  return {
    name: varname,
    label: String(attrs.long_name ?? attrs.standard_name ?? varname),
    units: typeof attrs.units === "string" ? attrs.units : undefined,
    reversed: String(attrs.positive).toLowerCase() === "down",
    points,
  };
}

/** Index of the point of a series (sorted by time) nearest to a time. */
export function nearestPointIndex(
  points: TTimeSeries["points"],
  time: number
): number {
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid].x <= time) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high > low && time - points[low].x > points[high].x - time
    ? high
    : low;
}
