<script lang="ts" setup>
import {
  Chart,
  Decimation,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
} from "chart.js";
import Annotation from "chartjs-plugin-annotation";
import dayjs from "dayjs";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  nearestPointIndex,
  pointsInRange,
  timeTicks,
  type TTimeSeries,
} from "@/lib/data/timeSeries.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  series: TTimeSeries;
  // epoch milliseconds of the time shown on the globe
  now?: number;
  // first and last time to show; the whole series when unset
  range?: [number, number];
}>();

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Decimation,
  Annotation
);

const LINE_COLOR = "rgb(74, 144, 217)";
const NOW_COLOR = "rgb(255, 140, 0)";

const canvasRef = ref<HTMLCanvasElement>();
let chart: Chart<"line", TTimeSeries["points"]> | undefined;

const units = computed(() =>
  props.series.units ? ` ${props.series.units}` : ""
);

// the value recorded nearest to the time shown, if the series covers it.
// ponytail: nearest however far; a record with long gaps shows a stale value
const valueNow = computed(() => {
  const points = props.series.points;
  if (
    props.now === undefined ||
    points.length === 0 ||
    props.now < points[0].x ||
    props.now > points[points.length - 1].x
  ) {
    return undefined;
  }
  const value = points[nearestPointIndex(points, props.now)].y;
  return Number.isFinite(value) ? value : undefined;
});

// the range asked for, unless it is empty or the series has nothing in it
function timeBounds() {
  const points = props.series.points;
  const first = points[0]?.x;
  const last = points[points.length - 1]?.x;
  const [min, max] = props.range ?? [first, last];
  return min < max && min < last && max > first
    ? { min, max }
    : { min: first, max: last };
}

function nowAnnotation(): Record<string, object> {
  if (props.now === undefined) {
    return {};
  }
  return {
    now: {
      type: "line",
      xMin: props.now,
      xMax: props.now,
      borderColor: NOW_COLOR,
      borderWidth: 1.5,
      borderDash: [4, 3],
    },
  };
}

const DAY = 86400000;

// hours within a day, days otherwise, with the year over a long span
function tickLabel(value: number, step: number, span: number) {
  const time = dayjs.utc(value);
  if (step < DAY && value % DAY !== 0) {
    return time.format("HH:mm");
  }
  return time.format(span > 300 * DAY ? "DD MMM YY" : "DD MMM");
}

function createChart() {
  chart?.destroy();
  if (!canvasRef.value) {
    return;
  }
  const bounds = timeBounds();
  const { step, ticks } = timeTicks(bounds.min, bounds.max);
  chart = new Chart(canvasRef.value, {
    type: "line",
    data: {
      datasets: [
        {
          // only the period shown: Chart.js keeps an element per point it
          // is given whenever the decimation has nothing to remove
          data: pointsInRange(props.series.points, bounds.min, bounds.max),
          borderColor: LINE_COLOR,
          borderWidth: 1,
          pointRadius: 0,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      // the points are {x, y} already and sorted: what the decimation needs
      parsing: false,
      normalized: true,
      scales: {
        x: {
          type: "linear",
          ...bounds,
          // the linear scale would put the ticks at round milliseconds
          afterBuildTicks: (axis) => {
            axis.ticks = ticks;
          },
          ticks: {
            callback: (value) =>
              tickLabel(Number(value), step, bounds.max - bounds.min),
          },
        },
        y: { reverse: props.series.reversed, ticks: { maxTicksLimit: 4 } },
      },
      plugins: {
        // one minimum and one maximum per pixel: spikes of a long record stay
        decimation: { enabled: true, algorithm: "min-max" },
        annotation: { annotations: nowAnnotation() },
      },
    },
  });
}

// another series or another period: a new chart
watch(
  [() => props.series, () => props.range?.[0], () => props.range?.[1]],
  createChart
);

watch(
  () => props.now,
  () => {
    if (!chart) {
      return;
    }
    (
      chart.options.plugins as unknown as {
        annotation: { annotations: Record<string, object> };
      }
    ).annotation.annotations = nowAnnotation();
    chart.update("none");
  }
);

onMounted(createChart);

onBeforeUnmount(() => {
  chart?.destroy();
  chart = undefined;
});
</script>

<template>
  <div class="mb-2">
    <div
      class="is-flex is-justify-content-space-between is-size-7 px-2"
      aria-live="off"
    >
      <span>{{ series.label }}{{ units ? ` (${units.trim()})` : "" }}</span>
      <span v-if="valueNow !== undefined" class="has-text-weight-semibold">
        {{ formatValue(valueNow) }}{{ units }}
      </span>
    </div>
    <div class="time-series-canvas">
      <canvas
        ref="canvasRef"
        role="img"
        :aria-label="`Time series of ${series.label}`"
      />
    </div>
  </div>
</template>

<style scoped>
.time-series-canvas {
  position: relative;
  height: 110px;
}
</style>
