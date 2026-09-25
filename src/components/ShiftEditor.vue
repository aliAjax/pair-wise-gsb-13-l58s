<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Shift } from "../types";
import {
  TIMELINE_LABEL,
  canSubmit,
  displayStatus,
  emptySegment,
  fmtDateTime,
  fmtMoney,
  fmtVolume,
  segmentAmount,
  segmentVolume,
  summarize,
  validateShift,
} from "../rules";

interface ActionResult {
  ok: boolean;
  error?: string;
}
const props = defineProps<{
  shift: Shift;
  fuels: string[];
  role: "operator" | "manager";
  actions: {
    saveDraft: (s: Shift) => ActionResult;
    submitReview: (s: Shift) => ActionResult;
    approve: (s: Shift) => ActionResult;
    reject: (s: Shift, reason: string) => ActionResult;
    submitCorrection: (s: Shift, reason: string) => ActionResult;
    remove: (s: Shift) => void;
  };
}>();

const emit = defineEmits<{
  (e: "persist"): void;
  (e: "cancelCorrection"): void;
}>();

const summary = computed(() => summarize(props.shift));
const issues = computed(() => validateShift(props.shift));
const submitCheck = computed(() => canSubmit(props.shift));
const badge = computed(() => displayStatus(props.shift));

const correcting = ref(false);
const correctionReason = ref("");
const rejectOpen = ref(false);
const rejectReason = ref("");
const actionError = ref("");

const readonly = computed(
  () => !correcting.value && (props.shift.status === "frozen" || props.shift.status === "reviewing")
);

const varianceText = computed(() => {
  const v = summary.value.variance;
  if (Math.abs(v) < 1e-6) return "账实一致";
  return v > 0 ? `长款 ¥${fmtMoney(v)}` : `短款 ¥${fmtMoney(Math.abs(v))}`;
});

const varianceCls = computed(() => {
  const v = summary.value.variance;
  if (Math.abs(v) < 1e-6) return "ok";
  return v > 0 ? "over" : "short";
});

const gapIds = computed(() => new Set(summary.value.bySegment.filter((r) => r.gap).map((r) => r.segment.id)));
const issueBySeg = computed(() => {
  const m = new Map<string, string[]>();
  for (const i of issues.value) {
    if (i.segmentId) m.set(i.segmentId, [...(m.get(i.segmentId) ?? []), i.message]);
  }
  return m;
});
const globalIssues = computed(() => issues.value.filter((i) => !i.segmentId).map((i) => i.message));

const openCorrection = computed(() => [...props.shift.corrections].reverse().find((c) => !c.closedAt));
const isCorrectionReview = computed(() => props.shift.status === "reviewing" && !!openCorrection.value);

// 静默自动保存：仅在录入/驳回状态生效，800ms 防抖，不写时间线。
// 订正期间不自动保存——改动只在内存中，提交订正或放弃（恢复冻结快照）时才落盘，
// 避免刷新页面留下“金额已改坏、状态仍冻结”的脏凭证。
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  [() => props.shift, correcting],
  () => {
    if (correcting.value) return;
    if (props.shift.status === "editing" || props.shift.status === "rejected") {
      clearTimeout(timer);
      timer = setTimeout(() => emit("persist"), 800);
    }
  },
  { deep: true }
);

watch(
  () => props.shift.status,
  (s) => {
    if (s !== "frozen") {
      correcting.value = false;
      correctionReason.value = "";
    }
    rejectOpen.value = false;
    rejectReason.value = "";
    actionError.value = "";
  }
);

function run(fn: () => ActionResult): boolean {
  const r = fn();
  actionError.value = r.ok ? "" : r.error ?? "操作失败";
  return r.ok;
}

function addSegment() {
  props.shift.segments.push(emptySegment(props.fuels[0] ?? ""));
}

function removeSegment(id: string) {
  const idx = props.shift.segments.findIndex((s) => s.id === id);
  if (idx >= 0) props.shift.segments.splice(idx, 1);
}

function startCorrection() {
  correcting.value = true;
  correctionReason.value = "";
  actionError.value = "";
}

function doPrint() {
  window.print();
}

function cancelCorrection() {
  // 放弃订正：由 App 用冻结快照恢复现场
  correcting.value = false;
  correctionReason.value = "";
  emit("cancelCorrection");
}

function doSubmitCorrection() {
  run(() => props.actions.submitCorrection(props.shift, correctionReason.value));
}

function doSaveDraft() {
  run(() => props.actions.saveDraft(props.shift));
}
function doSubmit() {
  run(() => props.actions.submitReview(props.shift));
}
function doApprove() {
  run(() => props.actions.approve(props.shift));
}
function doReject() {
  if (run(() => props.actions.reject(props.shift, rejectReason.value))) {
    rejectOpen.value = false;
    rejectReason.value = "";
  }
}
</script>

<template>
  <section class="editor">
    <!-- 凭证头 -->
    <header class="editor-head no-print">
      <div>
        <div class="title-row">
          <h2>交班拆账凭证</h2>
          <span class="badge" :class="badge.cls">{{ badge.label }}</span>
          <span v-if="shift.voucherNo" class="voucher-no">{{ shift.voucherNo }}</span>
        </div>
        <p class="meta-line">
          建班 {{ fmtDateTime(shift.createdAt) }} · 最近保存 {{ fmtDateTime(shift.updatedAt) }}
          <template v-if="shift.frozenAt"> · 冻结于 {{ fmtDateTime(shift.frozenAt) }}（{{ shift.approvedBy }}）</template>
        </p>
      </div>
      <div class="head-actions">
        <button v-if="shift.status === 'frozen'" type="button" class="secondary" @click="doPrint">打印凭证</button>
      </div>
    </header>

    <!-- 打印用凭证抬头 -->
    <header class="print-head print-only">
      <h1>{{ shift.station }} 交班凭证</h1>
      <p>凭证号：{{ shift.voucherNo ?? "（未冻结）" }}　打印时间：{{ fmtDateTime(new Date().toISOString()) }}</p>
    </header>

    <!-- 基本信息 -->
    <fieldset class="block" :disabled="readonly">
      <legend>班次信息</legend>
      <div class="grid-4">
        <label>加油站<input v-model="shift.station" placeholder="加油站名称" /></label>
        <label>班次日期<input v-model="shift.shiftDate" type="date" /></label>
        <label>
          班次
          <select v-model="shift.shift">
            <option value="早班">早班</option>
            <option value="中班">中班</option>
            <option value="晚班">晚班</option>
          </select>
        </label>
        <label>营业员<input v-model="shift.operator" placeholder="当班营业员" /></label>
      </div>
    </fieldset>

    <!-- 接班起泵码 -->
    <fieldset class="block" :disabled="readonly">
      <legend>接班起泵码（表底数，L）</legend>
      <div class="grid-4">
        <label v-for="f in fuels" :key="f">
          {{ f }}
          <input v-model="shift.openingReadings[f]" inputmode="decimal" placeholder="0.00" />
        </label>
      </div>
    </fieldset>

    <!-- 价格段拆账 -->
    <section class="block">
      <div class="block-head no-print" :class="{ disabled: readonly }">
        <legend>油品价格段（班中调价一次新增一段，逐段填写起止泵码与单价）</legend>
        <button type="button" class="secondary small" :disabled="readonly" @click="addSegment">＋ 新增价格段</button>
      </div>
      <h3 class="print-only">油品价格段</h3>

      <p v-if="globalIssues.length" class="issue-box no-print">
        <span v-for="(m, i) in globalIssues" :key="i">· {{ m }}<br /></span>
      </p>

      <div class="seg-list">
        <div v-for="(seg, i) in shift.segments" :key="seg.id" class="seg-row" :class="{ gap: gapIds.has(seg.id) }">
          <div class="seg-index">第 {{ i + 1 }} 段</div>
          <div class="seg-fields" :class="{ disabled: readonly }">
            <label>
              油品
              <select v-model="seg.fuel" :disabled="readonly">
                <option value="" disabled>请选择</option>
                <option v-for="f in fuels" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label>起始泵码<input v-model="seg.startReading" inputmode="decimal" :disabled="readonly" placeholder="接上段止码" /></label>
            <label>结束泵码<input v-model="seg.endReading" inputmode="decimal" :disabled="readonly" /></label>
            <label>单价(元/L)<input v-model="seg.price" inputmode="decimal" :disabled="readonly" placeholder="0.00" /></label>
            <div class="seg-calc">
              <span>走字 {{ fmtVolume(segmentVolume(seg)) }} L</span>
              <strong>应收 ¥{{ fmtMoney(segmentAmount(seg)) }}</strong>
            </div>
            <button type="button" class="danger small no-print" :disabled="readonly" @click="removeSegment(seg.id)">删除</button>
          </div>
          <p v-if="gapIds.has(seg.id) || issueBySeg.has(seg.id)" class="seg-warn no-print">
            ⚠ {{ (issueBySeg.get(seg.id) ?? ["泵码接不上，该段留在待修正"]).join("；") }}
          </p>
        </div>
        <div v-if="shift.segments.length === 0" class="empty">尚未登记价格段，点击“新增价格段”开始拆账</div>
      </div>
    </section>

    <!-- 收款与汇总 -->
    <section class="block summary-grid">
      <div class="collect" :class="{ disabled: readonly }">
        <h3>实际收款</h3>
        <label>现金（元）<input v-model="shift.cash" inputmode="decimal" :disabled="readonly" placeholder="0.00" /></label>
        <label>电子支付（元）<input v-model="shift.digital" inputmode="decimal" :disabled="readonly" placeholder="0.00" /></label>
      </div>

      <div class="sum-table">
        <h3>各段应收汇总</h3>
        <table>
          <thead>
            <tr><th>油品</th><th>泵码起</th><th>泵码止</th><th>单价</th><th>走字(L)</th><th>应收(元)</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in summary.bySegment" :key="row.segment.id" :class="{ warn: row.gap }">
              <td>{{ row.segment.fuel || "—" }}</td>
              <td>{{ row.segment.startReading || "空" }}</td>
              <td>{{ row.segment.endReading || "空" }}</td>
              <td>{{ row.segment.price || "空" }}</td>
              <td>{{ fmtVolume(row.volume) }}</td>
              <td>{{ fmtMoney(row.amount) }}</td>
            </tr>
          </tbody>
        </table>
        <dl class="fuel-sum">
          <template v-for="f in summary.byFuel" :key="f.fuel">
            <dt>{{ f.fuel }} 合计</dt>
            <dd>{{ fmtVolume(f.volume) }} L / ¥{{ fmtMoney(f.amount) }}</dd>
          </template>
        </dl>
      </div>

      <div class="totals">
        <div class="t-row"><span>总走字</span><strong>{{ fmtVolume(summary.totalVolume) }} L</strong></div>
        <div class="t-row"><span>应收合计</span><strong>¥{{ fmtMoney(summary.receivable) }}</strong></div>
        <div class="t-row"><span>现金</span><strong>¥{{ fmtMoney(summary.cash) }}</strong></div>
        <div class="t-row"><span>电子支付</span><strong>¥{{ fmtMoney(summary.digital) }}</strong></div>
        <div class="t-row"><span>实收合计</span><strong>¥{{ fmtMoney(summary.paid) }}</strong></div>
        <div class="t-row variance" :class="varianceCls">
          <span>长短款</span><strong>{{ varianceText }}</strong>
        </div>
      </div>
    </section>

    <!-- 长短款原因 -->
    <fieldset class="block" :disabled="readonly">
      <legend>长短款原因<span v-if="Math.abs(summary.variance) > 1e-6" class="req">（差异不为 0，必须写明原因才能送复核）</span></legend>
      <textarea
        v-model="shift.varianceReason"
        rows="2"
        placeholder="例如：夜间加油抹零 12 元、收到假钞 100 元待赔……"
      ></textarea>
    </fieldset>

    <!-- 订正原因输入 -->
    <fieldset v-if="correcting" class="block correction-box no-print">
      <legend>带原因订正（旧金额与时间将随凭证保留）</legend>
      <textarea v-model="correctionReason" rows="2" placeholder="请写明订正原因，例如：泵码抄录错误、收款渠道记错……"></textarea>
      <div class="inline-actions">
        <button type="button" class="primary" @click="doSubmitCorrection">提交订正并重送复核</button>
        <button type="button" class="secondary" @click="cancelCorrection">放弃，恢复冻结凭证</button>
      </div>
    </fieldset>

    <!-- 提交前阻断提示 -->
    <div v-if="!submitCheck.ok && !readonly" class="blockers no-print">
      <p>以下问题处理完才能送站长复核：</p>
      <ul><li v-for="(b, i) in submitCheck.blockers" :key="i">{{ b }}</li></ul>
    </div>
    <p v-if="actionError" class="error-msg no-print">{{ actionError }}</p>

    <!-- 操作区 -->
    <div class="action-bar no-print">
      <template v-if="shift.status === 'editing' || shift.status === 'rejected'">
        <button type="button" class="secondary" @click="doSaveDraft">保存草稿</button>
        <button type="button" class="primary" @click="doSubmit">送站长复核</button>
        <button type="button" class="danger ghost" @click="actions.remove(shift)">删除班次</button>
        <span v-if="shift.status === 'rejected'" class="hint-inline">上次复核被驳回，修改后重新送审</span>
      </template>

      <template v-else-if="shift.status === 'reviewing'">
        <span class="hint-inline">已送站长复核，营业员不可修改</span>
        <template v-if="role === 'manager'">
          <button type="button" class="primary" @click="doApprove">
            {{ isCorrectionReview ? "复核订正并重新冻结" : "复核通过，冻结整班" }}
          </button>
          <button type="button" class="danger" @click="rejectOpen = !rejectOpen">驳回</button>
        </template>
      </template>

      <template v-else-if="shift.status === 'frozen'">
        <span class="hint-inline">该班次已冻结为只读凭证{{ correcting ? "，正在订正" : "" }}</span>
        <button v-if="!correcting && role === 'operator'" type="button" class="primary" @click="startCorrection">带原因订正</button>
      </template>
    </div>

    <div v-if="rejectOpen" class="block reject-box no-print">
      <label>驳回原因（必填）<textarea v-model="rejectReason" rows="2" placeholder="写明需要营业员修正的问题"></textarea></label>
      <div class="inline-actions">
        <button type="button" class="danger" @click="doReject">确认驳回</button>
        <button type="button" class="secondary" @click="rejectOpen = false">取消</button>
      </div>
    </div>

    <!-- 历史订正留痕 -->
    <section v-if="shift.corrections.length" class="block history">
      <h3>订正记录（旧金额与时间留痕）</h3>
      <article v-for="c in shift.corrections" :key="c.id" class="corr-item">
        <header>
          <strong>{{ fmtDateTime(c.at) }} · {{ c.actor }} 发起订正</strong>
          <span class="badge" :class="c.closedAt ? 'st-frozen' : 'st-review'">
            {{ c.closedAt ? `已于 ${fmtDateTime(c.closedAt)} 复核关闭` : "待站长复核" }}
          </span>
        </header>
        <p class="corr-reason">原因：{{ c.reason }}</p>
        <table class="corr-money">
          <thead><tr><th></th><th>旧（冻结）</th><th>订正后</th></tr></thead>
          <tbody>
            <tr><td>应收</td><td>¥{{ fmtMoney(c.oldReceivable) }}</td><td>¥{{ fmtMoney(c.newReceivable) }}</td></tr>
            <tr><td>现金</td><td>¥{{ fmtMoney(c.oldCash) }}</td><td>¥{{ fmtMoney(c.newCash) }}</td></tr>
            <tr><td>电子支付</td><td>¥{{ fmtMoney(c.oldDigital) }}</td><td>¥{{ fmtMoney(c.newDigital) }}</td></tr>
          </tbody>
        </table>
        <ul v-if="c.changes.length" class="corr-changes">
          <li v-for="(ch, i) in c.changes" :key="i">{{ ch }}</li>
        </ul>
      </article>
    </section>

    <!-- 时间线 -->
    <section class="block history no-print">
      <h3>流转记录</h3>
      <ol class="timeline">
        <li v-for="ev in [...shift.timeline].reverse()" :key="ev.id">
          <span class="tl-kind">{{ TIMELINE_LABEL[ev.kind] }}</span>
          <span class="tl-note" v-if="ev.note">{{ ev.note }}</span>
          <span class="tl-meta">{{ ev.actor }} · {{ fmtDateTime(ev.at) }}</span>
        </li>
      </ol>
    </section>
  </section>
</template>
