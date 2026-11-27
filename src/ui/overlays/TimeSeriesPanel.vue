<script lang="ts" setup>
import { computedAsync } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed } from "vue";

import TimeSeriesChart from "./TimeSeriesChart.vue";

import { currentLevel } from "@/lib/data/levels.ts";
import { decodeTime, isTimeUnits } from "@/lib/data/timeHandling.ts";
import {
  loadTimeSeries,
  timeSeriesNames,
  type TTimeSeries,
} from "@/lib/data/timeSeries.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import CollapsibleCard from "@/ui/common/CollapsibleCard.vue";
import { useLog } from "@/ui/common/useLog.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const { logError } = useLog();
const { varinfo, dimSlidersDisplay, showDistanceScale } = storeToRefs(
  useGlobeControlStore()
);

// the variables of the dataset that are series along a time coordinate
const series = computedAsync(async () => {
  const datasources = props.datasources;
  if (!datasources) {
    return [];
  }
  const names = timeSeriesNames(currentLevel(datasources).datasources);
  const loaded: TTimeSeries[] = [];
  for (const result of await Promise.allSettled(
    names.map((name) => loadTimeSeries(datasources, name))
  )) {
    if (result.status === "fulfilled") {
      loaded.push(result.value);
    } else {
      logError(result.reason, "Couldn't load a time series");
    }
  }
  return loaded;
}, []);

// the time shown on the globe, in epoch milliseconds
const now = computed(() => {
  const dimInfo = varinfo.value?.dimInfo ?? [];
  for (let i = 0; i < dimInfo.length; i++) {
    const info = dimInfo[i];
    const index = dimSlidersDisplay.value[i];
    if (
      "attrs" in info &&
      isTimeUnits(info.attrs.units) &&
      typeof index === "number" &&
      index < info.values.length
    ) {
      return decodeTime(info.values[index], info.attrs).valueOf();
    }
  }
  return undefined;
});
</script>

<template>
  <div
    v-if="series.length > 0"
    class="time-series-panel"
    :class="{ 'above-distance-scale': showDistanceScale }"
  >
    <CollapsibleCard title="Time series">
      <TimeSeriesChart
        v-for="item in series"
        :key="item.name"
        :series="item"
        :now="now"
      />
    </CollapsibleCard>
  </div>
  <div v-else />
</template>

<style scoped>
.time-series-panel {
  position: absolute;
  left: 8px;
  bottom: 8px;
  width: min(26rem, calc(100% - 16px));
  z-index: 5;
}

.time-series-panel.above-distance-scale {
  bottom: 84px;
}
</style>
