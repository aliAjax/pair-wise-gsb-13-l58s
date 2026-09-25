<script setup lang="ts">
import { computed, ref } from "vue";
import type { Shift, ShiftStatus } from "../types";
import { displayStatus, fmtMoney, summarize } from "../rules";

const props = defineProps<{
  shifts: Shift[];
  currentId: string | null;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "create"): void;
}>();

type Filter = "all" | ShiftStatus | "mine-open";
const filter = ref<Filter>("all");

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部班次" },
  { value: "editing", label: "录入/待修正" },
  { value: "reviewing", label: "待复核" },
  { value: "frozen", label: "已冻结凭证" },
  { value: "rejected", label: "已驳回" },
];

const filtered = computed(() => {
  const list = [...props.shifts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (filter.value === "all") return list;
  if (filter.value === "editing") return list.filter((s) => s.status === "editing");
  return list.filter((s) => s.status === filter.value);
});

const counts = computed(() => ({
  total: props.shifts.length,
  reviewing: props.shifts.filter((s) => s.status === "reviewing").length,
  frozen: props.shifts.filter((s) => s.status === "frozen").length,
}));
</script>

<template>
  <aside class="list-panel">
    <div class="list-head">
      <h2>班次列表</h2>
      <button type="button" class="primary" @click="emit('create')">新建班次</button>
    </div>

    <div class="metrics-mini">
      <div><strong>{{ counts.total }}</strong><span>班次总数</span></div>
      <div><strong>{{ counts.reviewing }}</strong><span>待复核</span></div>
      <div><strong>{{ counts.frozen }}</strong><span>冻结凭证</span></div>
    </div>

    <div class="filters">
      <button
        v-for="f in FILTERS"
        :key="f.value"
        type="button"
        class="chip"
        :class="{ active: filter === f.value }"
        @click="filter = f.value"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="filtered.length === 0" class="empty">该筛选下暂无班次</div>
    <button
      v-for="s in filtered"
      :key="s.id"
      type="button"
      class="shift-card"
      :class="{ active: s.id === currentId }"
      @click="emit('select', s.id)"
    >
      <div class="card-top">
        <span class="card-title">{{ s.shiftDate }} {{ s.shift }}</span>
        <span class="badge" :class="displayStatus(s).cls">{{ displayStatus(s).label }}</span>
      </div>
      <div class="card-sub">{{ s.station }} · 营业员 {{ s.operator || "未填" }}</div>
      <div class="card-money">
        应收 ¥{{ fmtMoney(summarize(s).receivable) }}
        <em v-if="s.voucherNo">{{ s.voucherNo }}</em>
      </div>
    </button>
  </aside>
</template>
