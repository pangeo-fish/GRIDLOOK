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

import { nearestPointIndex, type TTimeSeries } from "@/lib/data/timeSeries.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  series: TTimeSeries;
  // epoch milliseconds of the time shown on the globe
  now?: number;
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

// the value recorded nearest to the time shown, if the series covers it
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
  return points[nearestPointIndex(points, props.now)].y;
});

/** At most `maxCount` ticks at 00:00 UTC, a whole number of days apart. */
function dayTicks(min: number, max: number, maxCount = 5) {
  const day = 86400000;
  const step = Math.max(1, Math.ceil((max - min) / day / maxCount)) * day;
  const ticks: { value: number }[] = [];
  for (let value = Math.ceil(min / day) * day; value <= max; value += step) {
    ticks.push({ value });
  }
  return ticks;
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

function createChart() {
  if (!canvasRef.value) {
    return;
  }
  const points = props.series.points;
  chart = new Chart(canvasRef.value, {
    type: "line",
    data: {
      datasets: [
        {
          data: points,
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
          min: points[0]?.x,
          max: points[points.length - 1]?.x,
          // the linear scale would put the ticks at round milliseconds
          afterBuildTicks: (axis) => {
            axis.ticks = dayTicks(axis.min, axis.max);
          },
          ticks: {
            callback: (value) => dayjs.utc(Number(value)).format("DD MMM"),
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
