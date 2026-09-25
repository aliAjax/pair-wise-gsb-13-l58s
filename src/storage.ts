// 本地存储层：只负责 localStorage 的读写、版本迁移和种子数据。
// 业务规则不写在这里；上层拿到的始终是完整对象的深拷贝。

import { round2, uid } from "./rules";
import type { Settings, Shift, StoreState } from "./types";

const STORAGE_KEY = "gas-station-shift-vouchers-v1";
export const STORAGE_VERSION = 1;

const DEFAULT_SETTINGS: Settings = {
  station: "示范加油站",
  fuels: ["92#汽油", "95#汽油", "0#柴油"],
  operator: "",
  manager: "",
};

function isoDaysAgo(days: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function seedShifts(): Shift[] {
  // 样例一：昨天中班，班中 92# 调过一次价，两段泵码衔接，已冻结凭证
  const created = isoDaysAgo(1, 14, 0);
  const frozenAt = isoDaysAgo(1, 22, 5);
  const frozen: Shift = {
    id: uid("shift"),
    station: DEFAULT_SETTINGS.station,
    shiftDate: isoDaysAgo(1, 0, 0).slice(0, 10),
    shift: "中班",
    operator: "王磊",
    manager: "李站长",
    openingReadings: { "92#汽油": "120000", "95#汽油": "88000", "0#柴油": "210000" },
    segments: [
      { id: uid("seg"), fuel: "92#汽油", startReading: "120000", endReading: "122600", price: "7.85" },
      // 18:00 调价 7.85 -> 7.92，新段起泵码与上段止泵码一致
      { id: uid("seg"), fuel: "92#汽油", startReading: "122600", endReading: "124380", price: "7.92" },
      { id: uid("seg"), fuel: "95#汽油", startReading: "88000", endReading: "89120", price: "8.41" },
    ],
    cash: "9800",
    // 92#: 2600*7.85 + 1780*7.92 = 20410 + 14097.6 = 34507.6
    // 95#: 1120*8.41 = 9419.2；应收合计 43926.8，现金 9800，电子 34126.8（账实一致）
    digital: String(round2(43926.8 - 9800)),
    varianceReason: "",
    status: "frozen",
    createdAt: created,
    updatedAt: frozenAt,
    submittedAt: isoDaysAgo(1, 21, 55),
    frozenAt,
    approvedBy: "李站长",
    corrections: [],
    timeline: [
      { id: uid("ev"), kind: "create", at: created, actor: "王磊" },
      { id: uid("ev"), kind: "submit", at: isoDaysAgo(1, 21, 55), actor: "王磊", note: "送站长复核" },
      { id: uid("ev"), kind: "approve", at: frozenAt, actor: "李站长", note: "复核通过，凭证号 PZ-DEMO-01（演示）" },
      { id: uid("ev"), kind: "freeze", at: frozenAt, actor: "李站长", note: "整班冻结为只读凭证" },
    ],
  };
  // 样例凭证号固定为演示号；正式凭证号在冻结时自动生成
  frozen.voucherNo = "PZ-DEMO-01（演示）";
  frozen.frozenSnapshot = JSON.parse(JSON.stringify(frozen)) as Shift;
  frozen.frozenSnapshot.frozenSnapshot = undefined;

  // 样例二：今天早班录入中，第二段泵码接不上，留在待修正
  const editing: Shift = {
    id: uid("shift"),
    station: DEFAULT_SETTINGS.station,
    shiftDate: new Date().toISOString().slice(0, 10),
    shift: "早班",
    operator: "周敏",
    manager: "李站长",
    openingReadings: { "92#汽油": "124380", "95#汽油": "89120", "0#柴油": "210000" },
    segments: [
      { id: uid("seg"), fuel: "0#柴油", startReading: "210000", endReading: "211400", price: "7.62" },
      // 调价后起止泵码没接上（应为 211400），演示“待修正”
      { id: uid("seg"), fuel: "0#柴油", startReading: "211410", endReading: "212060", price: "7.55" },
    ],
    cash: "3200",
    digital: "6100",
    varianceReason: "",
    status: "editing",
    createdAt: isoDaysAgo(0, 7, 5),
    updatedAt: isoDaysAgo(0, 9, 40),
    corrections: [],
    timeline: [{ id: uid("ev"), kind: "create", at: isoDaysAgo(0, 7, 5), actor: "周敏" }],
  };

  return [frozen, editing];
}

function defaultState(): StoreState {
  return {
    version: STORAGE_VERSION,
    shifts: seedShifts(),
    settings: { ...DEFAULT_SETTINGS },
  };
}

function migrate(raw: StoreState): StoreState {
  // 目前只有 v1；后续升版在这里做字段补齐，保证旧本地数据可用
  if (!raw || typeof raw !== "object") return defaultState();
  return {
    version: STORAGE_VERSION,
    shifts: Array.isArray(raw.shifts) ? raw.shifts : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
  };
}

export function loadState(): StoreState {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return defaultState();
    const parsed = JSON.parse(text) as StoreState;
    return migrate(parsed);
  } catch {
    return defaultState();
  }
}

export function saveState(state: StoreState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, version: STORAGE_VERSION }));
  } catch (err) {
    // 存储满或被禁用时不影响页面内存数据，仅在控制台留痕
    console.warn("班次数据写入本地存储失败", err);
  }
}

export function resetState(): StoreState {
  const state = defaultState();
  saveState(state);
  return state;
}
