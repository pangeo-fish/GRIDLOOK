/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
/**
 * Healpix.vue on a store of cells of mixed levels, as the dggs convention
 * writes them: `refinement_level: null`, `indexing_scheme: "zuniq"` (or
 * `"nuniq"`), one coordinate of cell ids that hold the level. Read through the
 * real ZarrDataManager; only the rendering and the workers are replaced.
 */
import "@/utils/disposablePolyfill.ts";

import { Grid, type GridOptions } from "healpix-geo";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { effectScope } from "vue";

type THoverLookup = (
  lat: number,
  lon: number
) => { value: number | null } | null;

const { beforeMount, scene, hover, faces, logError } = vi.hoisted(() => ({
  beforeMount: [] as (() => Promise<void>)[],
  scene: { current: undefined as unknown },
  hover: { lookup: null as THoverLookup | null },
  faces: [] as {
    grid: GridOptions;
    data: Float32Array;
    zuniqCells?: BigUint64Array;
  }[],
  logError: vi.fn(),
}));

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", () => ({
  useGridHoverLookup: () => ({
    clearHoverLookup: () => {
      hover.lookup = null;
    },
    setHoverLookup: (lookup: THoverLookup) => {
      hover.lookup = lookup;
    },
  }),
}));
vi.mock("@/ui/grids/composables/useGridCameraState.ts", () => ({
  useGridCameraState: vi.fn(),
}));
vi.mock("@/ui/grids/composables/useGridScene.ts", async () => {
  const { ref } = await import("vue");
  return {
    useGridScene: () => ({
      getScene: () => scene.current,
      getRenderer: () => undefined,
      redraw: vi.fn(),
      fitCameraToDataset: vi.fn(),
      hoveredGeoPoint: ref(null),
    }),
  };
});
vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  getLayerRenderOrder: () => 0,
  useGridOverlays: () => ({
    updateLandSeaMask: vi.fn(),
    updateTextureLayers: vi.fn(),
  }),
}));
// The grid data worker's read, on this thread.
vi.mock("@/lib/grids/gridDataWorkerClient.ts", async () => {
  const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
  return {
    getGridVariableData: async (request: {
      source: Parameters<typeof ZarrDataManager.getVariableInfo>[0];
      variable: string;
      selection: Parameters<typeof ZarrDataManager.getVariableData>[2];
    }) =>
      (
        await ZarrDataManager.getVariableData(
          request.source,
          request.variable,
          request.selection
        )
      ).data,
    terminateGridDataWorker: vi.fn(),
  };
});
// The face builder's worker, run in place.
vi.mock("@/lib/grids/healpixWorkerClient.ts", async () => {
  const healpix = await import("healpix-geo");
  const {
    buildMixedLevelGeometry,
    buildMixedLevelTexture,
    texelSize,
    zuniqLevels,
  } = await import("@/lib/grids/zuniqCells.ts");
  const { ProjectionHelper } =
    await import("@/lib/projection/projectionUtils.ts");
  return {
    terminateHealpixWorker: vi.fn(),
    buildHealpixFace: async (request: {
      grid: GridOptions;
      faceIndex: number;
      data: Float32Array;
      zuniqCells: BigUint64Array;
      projectionType: ConstructorParameters<typeof ProjectionHelper>[0];
      projectionCenter: ConstructorParameters<typeof ProjectionHelper>[1];
    }) => {
      faces.push({ ...request, data: request.data.slice() });
      using grid = new healpix.Grid(request.grid);
      const size = texelSize(request.zuniqCells.length);
      return {
        batchIndex: request.faceIndex,
        ...buildMixedLevelGeometry(
          grid,
          request.zuniqCells,
          3,
          new ProjectionHelper(
            request.projectionType,
            request.projectionCenter
          ),
          size.width,
          size.height
        ),
        ...buildMixedLevelTexture(
          request.data,
          zuniqLevels(request.zuniqCells),
          size.width,
          size.height
        ),
      };
    },
  };
});

const { createPinia, setActivePinia } = await import("pinia");
const { getGridType, GRID_TYPES } =
  await import("@/lib/data/gridTypeDetector.ts");
const { indexFromZarr } = await import("@/lib/data/sourceIndexing.ts");
const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
const { encodeZuniq } = await import("@/lib/grids/compactedCells.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Healpix } = await import("@/ui/grids/Healpix.vue");

const SRC = "https://example.test/mixed.zarr";

afterEach(() => {
  vi.restoreAllMocks();
  ZarrDataManager.invalidateCache();
});

function array(
  dataType: string,
  length: number,
  attributes: Record<string, unknown> = {}
) {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [length],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [length] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: dataType === "float32" ? "NaN" : 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    dimension_names: ["cells"],
    attributes,
  };
}

/** A store of one `cells` dimension: the ids, and a value per cell. */
function mixedStore(
  dggs: Record<string, unknown>,
  ids: bigint[],
  values: number[]
) {
  const encode = (json: unknown) =>
    new TextEncoder().encode(JSON.stringify(json));
  const coordinate = String(dggs.coordinate);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const coordinateNode = array("uint64", ids.length);
  const depthNode = array("float32", ids.length);
  files.set(
    `${SRC}/zarr.json`,
    encode({
      zarr_format: 3,
      node_type: "group",
      consolidated_metadata: {
        kind: "inline",
        must_understand: false,
        metadata: { [coordinate]: coordinateNode, depth: depthNode },
      },
      attributes: {
        zarr_conventions: [{ name: "dggs" }],
        dggs,
      },
    })
  );
  files.set(`${SRC}/${coordinate}/zarr.json`, encode(coordinateNode));
  files.set(
    `${SRC}/${coordinate}/c/0`,
    new Uint8Array(BigUint64Array.from(ids).buffer)
  );
  files.set(`${SRC}/depth/zarr.json`, encode(depthNode));
  files.set(
    `${SRC}/depth/c/0`,
    new Uint8Array(Float32Array.from(values).buffer)
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const file = files.get(url);
    return file ? new Response(file) : new Response(null, { status: 404 });
  });
}

async function mount(variable: string) {
  beforeMount.length = 0;
  faces.length = 0;
  hover.lookup = null;
  logError.mockClear();
  setActivePinia(createPinia());
  useGlobeControlStore().varnameSelector = variable;
  scene.current = new THREE.Scene();
  const sources = await indexFromZarr(SRC);
  const scope = effectScope();
  scope.run(() =>
    Healpix.setup!(
      { datasources: sources },
      { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
    )
  );
  await beforeMount[0]();
  return { scope, sources };
}

const dggs = (overrides: Record<string, unknown> = {}) => ({
  name: "healpix",
  refinement_level: null,
  indexing_scheme: "zuniq",
  spatial_dimension: "cells",
  coordinate: "zuniq",
  compression: "none",
  ellipsoid: { name: "sphere", radius: 6370997 },
  ...overrides,
});

function cellsAt(lon: number, lat: number, levels: number[]) {
  return levels.map((level) => {
    using grid = new Grid({ scheme: "nested", level });
    return encodeZuniq(
      level,
      grid.lonLatToHealpix(new Float64Array([lon, lat]))[0]
    );
  });
}

// two cells near Antwerp, level 11 and level 15, and one level-13 near the sea
const POINTS: [number, number][] = [
  [4.4, 51.2],
  [4.0, 51.4],
  [3.5, 51.5],
];
const LEVELS = [11, 15, 13];

function leafset() {
  const ids = POINTS.flatMap(([lon, lat], at) =>
    cellsAt(lon, lat, [LEVELS[at]])
  ).sort((a, b) => (a < b ? -1 : 1));
  return ids;
}

it("draws cells of mixed levels from a zuniq coordinate with refinement_level null", async () => {
  const ids = leafset();
  expect(ids.some((id) => id > 2n ** 53n)).toBe(true);
  mixedStore(dggs(), ids, [10, 20, 30]);
  const sources = await indexFromZarr(SRC);
  expect(await getGridType(true, "depth", sources, logError)).toBe(
    GRID_TYPES.HEALPIX
  );
  const { scope } = await mount("depth");
  expect(logError).not.toHaveBeenCalled();

  // one build with every cell at the id it was stored with, none rounded
  expect(faces).toHaveLength(1);
  expect(faces[0].grid.scheme).toBe("zuniq");
  expect([...faces[0].zuniqCells!]).toEqual(ids);
  expect([...faces[0].data]).toEqual([10, 20, 30]);

  // hover finds each cell at its own level, and nothing elsewhere
  const order = ids.map((id) => id);
  for (let at = 0; at < POINTS.length; at++) {
    const [lon, lat] = POINTS[at];
    const [cell] = cellsAt(lon, lat, [LEVELS[at]]);
    const index = order.indexOf(cell);
    expect(hover.lookup!(lat, lon)!.value).toBe([10, 20, 30][index]);
  }
  expect(hover.lookup!(10, 10)).toBeNull();
  scope.stop();
});

it("reads nuniq ids as the same cells", async () => {
  const ids = leafset();
  const fromZuniq = ids.map((id) => {
    const trailing =
      id.toString(2).length - 1 - id.toString(2).lastIndexOf("1");
    const level = 29 - trailing / 2;
    return 4n ** BigInt(level + 1) + (id >> BigInt(trailing + 1));
  });
  mixedStore(
    dggs({ indexing_scheme: "nuniq", coordinate: "nuniq" }),
    fromZuniq,
    [10, 20, 30]
  );
  const { scope } = await mount("depth");
  expect(logError).not.toHaveBeenCalled();
  expect([...faces[0].zuniqCells!]).toEqual(ids);
  scope.stop();
});

it("does not take a null level of a scheme without levels in its ids", async () => {
  mixedStore(dggs({ indexing_scheme: "nested" }), [0n, 1n, 2n], [1, 2, 3]);
  // not the mixed-level path: the ordinary one finds no grid for 3 cells
  const { scope } = await mount("depth");
  expect(faces).toHaveLength(0);
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining(
        "Could not determine HEALPix grid parameters"
      ),
    }),
    expect.anything()
  );
  scope.stop();
});
