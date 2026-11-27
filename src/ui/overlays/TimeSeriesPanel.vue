<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

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
const names = computed(() =>
  props.datasources
    ? timeSeriesNames(currentLevel(props.datasources).datasources)
    : []
);

// which arrays they are: the series are read again only when this changes,
// not with every change inside the dataset (the level picked while zooming)
const seriesKey = computed(() => {
  if (!props.datasources) {
    return "";
  }
  const sources = currentLevel(props.datasources).datasources;
  return names.value
    .map((name) => `${sources[name].store}\n${sources[name].dataset}\n${name}`)
    .join("\n\n");
});

// shallow: the points are plain data, far too many to make reactive
const series = shallowRef<TTimeSeries[]>([]);

watch(
  seriesKey,
  async (key) => {
    const datasources = props.datasources;
    const loaded: TTimeSeries[] = [];
    for (const result of await Promise.allSettled(
      names.value.map((name) => loadTimeSeries(datasources!, name))
    )) {
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      } else {
        logError(result.reason, "Couldn't load a time series");
      }
    }
    // another dataset may have been opened meanwhile
    if (key === seriesKey.value) {
      series.value = loaded;
    }
  },
  { immediate: true }
);

// a record can be much longer than the period of the maps (a tag keeps
// recording after the track ends): the charts show that period by default
const wholeRecord = ref(false);

// the time shown on the globe and the first and last time of the maps, in
// epoch milliseconds
const mapTime = computed(() => {
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
      const timeAt = (at: number) =>
        decodeTime(info.values[at], info.attrs).valueOf();
      return {
        now: timeAt(index),
        range: [timeAt(0), timeAt(info.values.length - 1)] as [number, number],
      };
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
        :now="mapTime?.now"
        :range="wholeRecord ? undefined : mapTime?.range"
      />
      <label class="checkbox is-size-7 px-2">
        <input v-model="wholeRecord" type="checkbox" />
        Whole record
      </label>
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

/* clears the distance scale (DistanceScale.vue), drawn in the same corner */
.time-series-panel.above-distance-scale {
  bottom: 84px;
}
</style>
