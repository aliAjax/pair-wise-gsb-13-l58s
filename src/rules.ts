// 业务规则层：全部为纯函数，不碰 DOM、不碰 localStorage。
// 价格段拆账、泵码衔接校验、汇总、长短款、状态流转、冻结订正比对都在这里。

import type {
  CorrectionEntry,
  FuelSummary,
  Issue,
  PriceSegment,
  SegmentSummary,
  Shift,
  ShiftSummary,
  TimelineEvent,
  TimelineEventKind,
} from "./types";

export const STORAGE_VERSION = 1;
const EPS = 1e-6;

let seq = 0;
export function uid(prefix = "id"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNum(value: string | number | undefined | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 金额保留两位小数，规避浮点尾差 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function fmtMoney(n: number): string {
  return round2(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtVolume(n: number): string {
  return round2(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function emptySegment(fuel = ""): PriceSegment {
  return { id: uid("seg"), fuel, startReading: "", endReading: "", price: "" };
}

export function segmentVolume(seg: PriceSegment): number {
  const v = toNum(seg.endReading) - toNum(seg.startReading);
  return v > 0 ? round2(v) : 0;
}

export function segmentAmount(seg: PriceSegment): number {
  return round2(segmentVolume(seg) * toNum(seg.price));
}

/**
 * 校验价格段与泵码衔接：
 * 1) 每段油品/起止泵码/单价必填，起 < 止，单价 >= 0；
 * 2) 同一油品按录入顺序逐段衔接，第一段起泵码必须等于接班起泵码，
 *    后一段起泵码必须等于上一段止泵码；接不上即标记问题，班次留在“待修正”。
 */
export function validateShift(shift: Shift): Issue[] {
  const issues: Issue[] = [];
  if (!shift.shiftDate) issues.push({ message: "班次日期未填写" });
  if (!shift.shift) issues.push({ message: "班次（早/中/晚）未选择" });
  if (!shift.operator.trim()) issues.push({ message: "营业员未填写" });

  if (shift.segments.length === 0) {
    issues.push({ message: "至少需要登记一个油品价格段" });
  }

  // 按油品分组，保持录入顺序（调价后新增的段天然排在后面）
  const groups = new Map<string, PriceSegment[]>();
  for (const seg of shift.segments) {
    if (!seg.fuel) {
      issues.push({ segmentId: seg.id, message: "存在未选择油品的价格段" });
      continue;
    }
    const list = groups.get(seg.fuel) ?? [];
    list.push(seg);
    groups.set(seg.fuel, list);
  }

  for (const seg of shift.segments) {
    if (!seg.fuel) continue;
    if (String(seg.startReading).trim() === "") {
      issues.push({ segmentId: seg.id, message: `${seg.fuel} 价格段缺少起始泵码` });
    }
    if (String(seg.endReading).trim() === "") {
      issues.push({ segmentId: seg.id, message: `${seg.fuel} 价格段缺少结束泵码` });
    }
    if (String(seg.price).trim() === "") {
      issues.push({ segmentId: seg.id, message: `${seg.fuel} 价格段缺少单价` });
    } else if (toNum(seg.price) < 0) {
      issues.push({ segmentId: seg.id, message: `${seg.fuel} 单价不能为负` });
    }
    if (String(seg.startReading).trim() !== "" && String(seg.endReading).trim() !== "") {
      const start = toNum(seg.startReading);
      const end = toNum(seg.endReading);
      if (start < 0 || end < 0) {
        issues.push({ segmentId: seg.id, message: `${seg.fuel} 泵码不能为负` });
      } else if (Math.abs(end - start) <= EPS) {
        issues.push({ segmentId: seg.id, message: `${seg.fuel} 本段泵码走字为 0，请核对起止泵码` });
      } else if (end < start) {
        issues.push({ segmentId: seg.id, message: `${seg.fuel} 结束泵码小于起始泵码` });
      }
    }
  }

  for (const [fuel, list] of groups) {
    const opening = toNum(shift.openingReadings[fuel]);
    const hasOpening = String(shift.openingReadings[fuel] ?? "").trim() !== "";
    list.forEach((seg, i) => {
      const expect = i === 0 ? (hasOpening ? opening : null) : toNum(list[i - 1].endReading);
      const actual = toNum(seg.startReading);
      const label = i === 0 ? `接班起泵码 ${hasOpening ? opening : "（空）"}` : `上一段止泵码 ${toNum(list[i - 1].endReading)}`;
      if (expect === null) {
        issues.push({ segmentId: seg.id, message: `${fuel} 第 ${i + 1} 段接不上：未登记${label}` });
      } else if (String(seg.startReading).trim() === "" || Math.abs(actual - expect) > EPS) {
        issues.push({
          segmentId: seg.id,
          message: `${fuel} 第 ${i + 1} 段起泵码 ${String(seg.startReading).trim() === "" ? "为空" : actual} 与${label}接不上`,
        });
      }
    });
  }

  return issues;
}

/** 汇总：逐段走字与应收 -> 按油品汇总 -> 现金/电子支付合计 -> 长短款 */
export function summarize(shift: Shift): ShiftSummary {
  const bySegment: SegmentSummary[] = [];
  const fuelMap = new Map<string, FuelSummary>();
  let totalVolume = 0;
  let receivable = 0;

  // 复用校验里的衔接判定，给每段打 gap 标记
  const groups = new Map<string, PriceSegment[]>();
  for (const seg of shift.segments) {
    const list = groups.get(seg.fuel) ?? [];
    list.push(seg);
    groups.set(seg.fuel, list);
  }
  const gapIds = new Set<string>();
  for (const [fuel, list] of groups) {
    const opening = shift.openingReadings[fuel];
    list.forEach((seg, i) => {
      let gap = false;
      if (String(seg.startReading).trim() === "") gap = true;
      if (i === 0) {
        if (String(opening ?? "").trim() === "" || Math.abs(toNum(seg.startReading) - toNum(opening)) > EPS) gap = true;
      } else if (Math.abs(toNum(seg.startReading) - toNum(list[i - 1].endReading)) > EPS) {
        gap = true;
      }
      if (gap) gapIds.add(seg.id);
    });
  }

  for (const seg of shift.segments) {
    const volume = segmentVolume(seg);
    const amount = segmentAmount(seg);
    bySegment.push({ segment: seg, volume, amount, gap: gapIds.has(seg.id) });
    totalVolume += volume;
    receivable += amount;
    if (seg.fuel) {
      const row = fuelMap.get(seg.fuel) ?? { fuel: seg.fuel, volume: 0, amount: 0 };
      row.volume = round2(row.volume + volume);
      row.amount = round2(row.amount + amount);
      fuelMap.set(seg.fuel, row);
    }
  }

  const cash = round2(toNum(shift.cash));
  const digital = round2(toNum(shift.digital));
  const paid = round2(cash + digital);
  receivable = round2(receivable);
  totalVolume = round2(totalVolume);

  return {
    bySegment,
    byFuel: [...fuelMap.values()],
    totalVolume,
    receivable,
    cash,
    digital,
    paid,
    variance: round2(paid - receivable),
  };
}

/** 是否允许送站长复核：无泵码/录入问题，且长短款不为 0 时写明原因 */
export function canSubmit(shift: Shift): { ok: boolean; blockers: string[] } {
  const blockers: string[] = validateShift(shift).map((i) => i.message);
  const summary = summarize(shift);
  if (Math.abs(summary.variance) > EPS && !shift.varianceReason.trim()) {
    blockers.push("存在长短款，必须写明原因后才能送站长复核");
  }
  return { ok: blockers.length === 0, blockers };
}

function event(kind: TimelineEventKind, actor: string, note?: string): TimelineEvent {
  return { id: uid("ev"), kind, at: new Date().toISOString(), actor, note };
}

function touch(shift: Shift): Shift {
  shift.updatedAt = new Date().toISOString();
  return shift;
}

/** 营业员保存录入（仍处于编辑/待修正） */
export function markSaved(shift: Shift, actor: string): Shift {
  shift.timeline.push(event("save", actor));
  return touch(shift);
}

/** 送站长复核：泵码必须全部接上，长短款必须有原因 */
export function submitForReview(shift: Shift, actor: string): Shift {
  const check = canSubmit(shift);
  if (!check.ok) {
    throw new Error(check.blockers.join("；"));
  }
  shift.status = "reviewing";
  shift.submittedAt = new Date().toISOString();
  shift.timeline.push(event("submit", actor, "送站长复核"));
  return touch(shift);
}

function nextVoucherNo(shifts: Shift[]): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = `PZ-${ymd}-`;
  const max = shifts
    .map((s) => s.voucherNo)
    .filter((no): no is string => !!no && no.startsWith(prefix))
    .map((no) => Number(no.slice(prefix.length)))
    .reduce((a, b) => Math.max(a, Number.isFinite(b) ? b : 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

/** 站长复核通过：整班冻结成只读凭证 */
export function approve(shift: Shift, actor: string, allShifts: Shift[]): Shift {
  if (shift.status !== "reviewing") throw new Error("只有待复核班次可以通过");
  const check = canSubmit(shift);
  if (!check.ok) throw new Error(check.blockers.join("；"));
  shift.status = "frozen";
  freezeNow(shift, actor, allShifts, "复核通过");
  return touch(shift);
}

/** 站长复核驳回：退回营业员修正 */
export function reject(shift: Shift, actor: string, reason: string): Shift {
  if (shift.status !== "reviewing") throw new Error("只有待复核班次可以驳回");
  if (!reason.trim()) throw new Error("驳回必须填写原因");
  shift.status = "rejected";
  shift.timeline.push(event("reject", actor, reason.trim()));
  return touch(shift);
}

/** 被驳回的班次修改后重新送审 */
export function resubmit(shift: Shift, actor: string): Shift {
  if (shift.status !== "rejected" && shift.status !== "editing") {
    throw new Error("当前状态不能送审");
  }
  return submitForReview(shift, actor);
}

/** 深拷贝班次（用于冻结快照，避免后续订正污染旧凭证金额）。
 *  剥掉快照自身的 frozenSnapshot，防止多次订正后快照层层嵌套膨胀。 */
export function cloneShift(shift: Shift): Shift {
  const copy = JSON.parse(JSON.stringify(shift)) as Shift;
  copy.frozenSnapshot = undefined;
  return copy;
}

/** 冻结：生成凭证号，写入冻结事件后保存“不含快照”的冻结快照 */
function freezeNow(shift: Shift, actor: string, allShifts: Shift[], note: string): void {
  shift.status = "frozen";
  shift.approvedBy = actor;
  shift.frozenAt = new Date().toISOString();
  shift.voucherNo = shift.voucherNo ?? nextVoucherNo(allShifts);
  shift.timeline.push(event("approve", actor, `${note}，凭证号 ${shift.voucherNo}`));
  shift.timeline.push(event("freeze", actor, "整班冻结为只读凭证"));
  shift.frozenSnapshot = cloneShift(shift);
}

function fmtNumForDiff(v: string): string {
  return String(v ?? "").trim() === "" ? "空" : String(v);
}

/**
 * 冻结凭证再次打开时只能“带原因订正”：
 * 比对冻结快照与当前修改，逐条记录字段级变化，并留下旧金额与时间。
 * 返回留痕条目；调用方负责把状态改为 reviewing 并清空 frozenSnapshot。
 */
export function buildCorrection(original: Shift, modified: Shift, actor: string, reason: string): CorrectionEntry {
  if (!reason.trim()) throw new Error("订正必须填写原因");
  const changes: string[] = [];

  const fieldLabels: Array<[keyof Shift, string]> = [
    ["station", "加油站"],
    ["shiftDate", "班次日期"],
    ["shift", "班次"],
    ["operator", "营业员"],
    ["manager", "值班站长"],
  ];
  for (const [key, label] of fieldLabels) {
    if (String(original[key] ?? "") !== String(modified[key] ?? "")) {
      changes.push(`${label}：${original[key] || "空"} → ${modified[key] || "空"}`);
    }
  }

  const oldSegs = original.segments;
  const newSegs = modified.segments;
  newSegs.forEach((seg, i) => {
    const before = oldSegs[i];
    const name = `${seg.fuel || "未知油品"}第${i + 1}段`;
    if (!before) {
      changes.push(`${name}：新增价格段（${fmtNumForDiff(seg.startReading)}→${fmtNumForDiff(seg.endReading)}，单价${fmtNumForDiff(seg.price)}）`);
      return;
    }
    if (before.fuel !== seg.fuel) changes.push(`${name}油品：${before.fuel} → ${seg.fuel}`);
    if (String(before.startReading) !== String(seg.startReading)) {
      changes.push(`${name}起始泵码：${fmtNumForDiff(before.startReading)} → ${fmtNumForDiff(seg.startReading)}`);
    }
    if (String(before.endReading) !== String(seg.endReading)) {
      changes.push(`${name}结束泵码：${fmtNumForDiff(before.endReading)} → ${fmtNumForDiff(seg.endReading)}`);
    }
    if (String(before.price) !== String(seg.price)) {
      changes.push(`${name}单价：${fmtNumForDiff(before.price)} → ${fmtNumForDiff(seg.price)}`);
    }
  });
  if (oldSegs.length > newSegs.length) {
    oldSegs.slice(newSegs.length).forEach((seg, i) => {
      changes.push(`删除价格段：${seg.fuel}第${newSegs.length + i + 1}段（${fmtNumForDiff(seg.startReading)}→${fmtNumForDiff(seg.endReading)}，单价${fmtNumForDiff(seg.price)}）`);
    });
  }

  if (String(original.cash) !== String(modified.cash)) {
    changes.push(`现金：${fmtNumForDiff(original.cash)} → ${fmtNumForDiff(modified.cash)}`);
  }
  if (String(original.digital) !== String(modified.digital)) {
    changes.push(`电子支付：${fmtNumForDiff(original.digital)} → ${fmtNumForDiff(modified.digital)}`);
  }
  if (String(original.varianceReason) !== String(modified.varianceReason)) {
    changes.push(`长短款原因：${original.varianceReason || "空"} → ${modified.varianceReason || "空"}`);
  }

  const oldSum = summarize(original);
  const newSum = summarize(modified);

  return {
    id: uid("cor"),
    reason: reason.trim(),
    at: new Date().toISOString(),
    actor,
    oldReceivable: oldSum.receivable,
    oldCash: oldSum.cash,
    oldDigital: oldSum.digital,
    newReceivable: newSum.receivable,
    newCash: newSum.cash,
    newDigital: newSum.digital,
    changes,
  };
}

/** 提交订正：留痕、状态回到 reviewing，旧冻结金额保留在 corrections 中 */
export function submitCorrection(modified: Shift, actor: string, reason: string): Shift {
  if (modified.status !== "frozen" || !modified.frozenSnapshot) {
    throw new Error("只有冻结凭证可以发起订正");
  }
  const entry = buildCorrection(modified.frozenSnapshot, modified, actor, reason);
  if (entry.changes.length === 0) throw new Error("没有检测到任何改动，无需订正");
  const check = canSubmit(modified);
  if (!check.ok) throw new Error(check.blockers.join("；"));

  modified.corrections.push(entry);
  modified.status = "reviewing";
  modified.submittedAt = new Date().toISOString();
  modified.approvedBy = undefined;
  modified.frozenAt = undefined;
  modified.voucherNo = undefined;
  // 保留冻结快照：订正若被站长驳回，用它恢复只读凭证
  modified.timeline.push(event("correct", actor, `带原因订正：${reason.trim()}；旧应收 ${fmtMoney(entry.oldReceivable)} 元（${fmtDateTime(entry.at)}）`));
  modified.timeline.push(event("submit", actor, "订正后重新送站长复核"));
  return touch(modified);
}

/** 站长通过一次订正：重新冻结，并关闭最近一条留痕 */
export function approveCorrection(shift: Shift, actor: string, allShifts: Shift[]): Shift {
  const open = [...shift.corrections].reverse().find((c) => !c.closedAt);
  if (shift.status !== "reviewing" || !open) throw new Error("没有待复核的订正");
  const check = canSubmit(shift);
  if (!check.ok) throw new Error(check.blockers.join("；"));
  shift.status = "frozen";
  shift.approvedBy = actor;
  shift.frozenAt = new Date().toISOString();
  shift.voucherNo = shift.voucherNo ?? nextVoucherNo(allShifts);
  open.closedAt = shift.frozenAt;
  freezeNow(shift, actor, allShifts, "订正复核通过");
  return touch(shift);
}

/** 站长驳回一次订正：恢复冻结快照，凭证重新只读，驳回原因留在该条留痕上 */
export function rejectCorrection(shift: Shift, actor: string, reason: string): Shift {
  if (!reason.trim()) throw new Error("驳回必须填写原因");
  const open = [...shift.corrections].reverse().find((c) => !c.closedAt);
  if (shift.status !== "reviewing" || !open || !shift.frozenSnapshot) {
    throw new Error("当前没有可驳回的订正");
  }
  const snapshot = cloneShift(shift.frozenSnapshot);
  // 保留驳回痕迹到时间线与订正条目本身（快照里没有这次记录）
  snapshot.corrections = shift.corrections.map((c) =>
    c.id === open.id ? { ...c, closedAt: new Date().toISOString(), reason: `${c.reason}【驳回：${reason.trim()}】` } : c
  );
  snapshot.timeline = [
    ...shift.timeline,
    event("reject", actor, `订正驳回：${reason.trim()}，恢复冻结金额 ¥${fmtMoney(open.oldReceivable)}`),
    event("freeze", actor, "凭证恢复只读"),
  ];
  Object.assign(shift, snapshot);
  // 恢复后重新以当前只读内容为冻结快照，保证还能继续发起下一次订正
  shift.frozenSnapshot = cloneShift(shift);
  return touch(shift);
}

export const STATUS_META: Record<Shift["status"], { label: string; cls: string }> = {
  editing: { label: "待修正", cls: "st-fix" },
  reviewing: { label: "待复核", cls: "st-review" },
  frozen: { label: "已冻结", cls: "st-frozen" },
  rejected: { label: "已驳回", cls: "st-reject" },
};

/** editing 且无校验问题时，界面状态徽标可显示“待提交”，但存储状态仍是 editing */
export function displayStatus(shift: Shift): { label: string; cls: string } {
  if (shift.status === "editing" && validateShift(shift).length === 0) {
    return { label: "待提交", cls: "st-ready" };
  }
  return STATUS_META[shift.status];
}

export const TIMELINE_LABEL: Record<TimelineEventKind, string> = {
  create: "建班",
  save: "保存",
  submit: "送复核",
  approve: "复核通过",
  reject: "复核驳回",
  correct: "发起订正",
  freeze: "冻结凭证",
};
