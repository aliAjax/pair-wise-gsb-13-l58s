<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import ShiftList from "./components/ShiftList.vue";
import ShiftEditor from "./components/ShiftEditor.vue";
import { loadState, resetState, saveState } from "./storage";
import {
  approve,
  approveCorrection,
  cloneShift,
  markSaved,
  reject as rejectReview,
  rejectCorrection,
  resubmit,
  submitCorrection,
  uid,
} from "./rules";
import type { Settings, Shift, ShiftName, StoreState } from "./types";

const state = reactive<StoreState>(loadState());

const role = ref<"operator" | "manager">("operator");
const currentId = ref<string | null>(state.shifts[0]?.id ?? null);
const settingsOpen = ref(false);
const settingsDraft = reactive<Settings>({ ...state.settings });

const current = computed(() => state.shifts.find((s) => s.id === currentId.value) ?? null);

watch(
  state,
  () => saveState(state),
  { deep: true }
);

function actor(): string {
  const name = role.value === "manager" ? state.settings.manager : state.settings.operator;
  return name.trim() || (role.value === "manager" ? "站长" : "营业员");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function createShift() {
  const shift: Shift = {
    id: uid("shift"),
    station: state.settings.station,
    shiftDate: today(),
    shift: "早班" as ShiftName,
    operator: state.settings.operator,
    manager: state.settings.manager,
    openingReadings: Object.fromEntries(state.settings.fuels.map((f) => [f, ""])),
    segments: [],
    cash: "",
    digital: "",
    varianceReason: "",
    status: "editing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    corrections: [],
    timeline: [{ id: uid("ev"), kind: "create", at: new Date().toISOString(), actor: actor() }],
  };
  state.shifts.unshift(shift);
  currentId.value = shift.id;
}

function removeShift(s: Shift) {
  if (!window.confirm(`确认删除 ${s.shiftDate} ${s.shift}？`)) return;
  const idx = state.shifts.findIndex((x) => x.id === s.id);
  if (idx >= 0) state.shifts.splice(idx, 1);
  if (currentId.value === s.id) currentId.value = state.shifts[0]?.id ?? null;
}

function persist() {
  saveState(state);
}

// 交给编辑器的操作集合：这里统一编排 rules 纯函数 + storage 持久化
const actions = computed(() => ({
  saveDraft(s: Shift) {
    try {
      markSaved(s, actor());
      saveState(state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  submitReview(s: Shift) {
    try {
      if (s.status === "rejected" || s.status === "editing") resubmit(s, actor());
      saveState(state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  approve(s: Shift) {
    try {
      const hasOpenCorrection = s.corrections.some((c) => !c.closedAt);
      if (hasOpenCorrection) approveCorrection(s, actor(), state.shifts);
      else approve(s, actor(), state.shifts);
      saveState(state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  reject(s: Shift, reason: string) {
    try {
      const hasOpenCorrection = s.corrections.some((c) => !c.closedAt);
      if (hasOpenCorrection) rejectCorrection(s, actor(), reason);
      else rejectReview(s, actor(), reason);
      saveState(state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  submitCorrection(s: Shift, reason: string) {
    try {
      submitCorrection(s, actor(), reason);
      saveState(state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  remove: removeShift,
}));

function onCancelCorrection() {
  const s = current.value;
  if (!s?.frozenSnapshot) return;
  const snapshot = cloneShift(s.frozenSnapshot);
  const idx = state.shifts.findIndex((x) => x.id === s.id);
  state.shifts.splice(idx, 1, snapshot);
  saveState(state);
}

const fuelsText = ref(state.settings.fuels.join("\n"));

watch(settingsOpen, (open) => {
  if (open) fuelsText.value = state.settings.fuels.join("\n");
});

function saveSettings() {
  const fuels = fuelsText.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // 新增油品时给历史班次补空的接班泵码；删除油品不删历史价格段
  const added = fuels.filter((f) => !state.settings.fuels.includes(f));
  state.settings.station = settingsDraft.station.trim() || "加油站";
  state.settings.fuels = fuels;
  state.settings.operator = settingsDraft.operator.trim();
  state.settings.manager = settingsDraft.manager.trim();
  for (const s of state.shifts) {
    for (const f of added) s.openingReadings[f] = "";
  }
  settingsOpen.value = false;
  saveState(state);
}

function resetAll() {
  if (!window.confirm("将清空本地班次并恢复演示数据，确认继续？")) return;
  const fresh = resetState();
  state.shifts = fresh.shifts;
  state.settings = fresh.settings;
  Object.assign(settingsDraft, fresh.settings);
  currentId.value = fresh.shifts[0]?.id ?? null;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar no-print">
        <div>
          <p class="eyebrow">班中调价 · 按价格段拆账交班</p>
          <h1>加油站班次交接凭证</h1>
          <p class="subtitle">
            一个班次可记多个油品价格段，逐段填写起止泵码与单价；泵码接不上留在待修正。
            现金与电子支付对照各段应收，长短款写明原因后送站长复核；通过即冻结为只读凭证，再次打开只能带原因订正。
          </p>
        </div>
        <div class="top-side">
          <div class="role-switch" role="group" aria-label="角色切换">
            <button type="button" :class="{ active: role === 'operator' }" @click="role = 'operator'">营业员</button>
            <button type="button" :class="{ active: role === 'manager' }" @click="role = 'manager'">站长</button>
          </div>
          <button type="button" class="secondary small" @click="settingsOpen = !settingsOpen">
            {{ settingsOpen ? "收起设置" : "油站与油品设置" }}
          </button>
        </div>
      </header>

      <section v-if="settingsOpen" class="settings no-print">
        <h3>本地设置（仅存本机浏览器）</h3>
        <div class="settings-grid">
          <label>加油站名称<input v-model="settingsDraft.station" /></label>
          <label>营业员姓名<input v-model="settingsDraft.operator" placeholder="用于操作留痕" /></label>
          <label>站长姓名<input v-model="settingsDraft.manager" placeholder="用于复核留痕" /></label>
          <label class="fuels-edit">
            油品种类（每行一个）
            <textarea v-model="fuelsText" rows="4" placeholder="92#汽油&#10;95#汽油&#10;0#柴油"></textarea>
          </label>
        </div>
        <div class="inline-actions">
          <button type="button" class="primary small" @click="saveSettings">保存设置</button>
          <button type="button" class="danger ghost small" @click="resetAll">恢复演示数据</button>
        </div>
      </section>

      <div class="workspace">
        <ShiftList :shifts="state.shifts" :current-id="currentId" @select="currentId = $event" @create="createShift" />

        <section v-if="current" class="editor-wrap">
          <ShiftEditor
            :key="current.id"
            :shift="current"
            :fuels="state.settings.fuels"
            :role="role"
            :actions="actions"
            @persist="persist"
            @cancel-correction="onCancelCorrection"
          />
        </section>
        <section v-else class="empty-state no-print">
          <p>左侧选择一个班次，或点击“新建班次”开始登记。</p>
          <button type="button" class="primary" @click="createShift">新建班次</button>
        </section>
      </div>
    </div>
  </main>
</template>
