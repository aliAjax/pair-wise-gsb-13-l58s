// 数据模型层：只描述交班拆账用到的结构，不含任何业务判断和界面逻辑。

export type ShiftName = "早班" | "中班" | "晚班";

export const SHIFT_NAMES: ShiftName[] = ["早班", "中班", "晚班"];

/** 班次状态机：
 * editing  营业员录入中（有泵码接不上等问题时界面上标为“待修正”，仍归 editing）
 * reviewing 已送站长复核
 * frozen    复核通过，整班冻结为只读凭证
 * rejected  复核驳回，退回营业员修改
 */
export type ShiftStatus = "editing" | "reviewing" | "frozen" | "rejected";

/** 一个油品价格段：同一油品调价一次就新增一段 */
export interface PriceSegment {
  id: string;
  fuel: string;
  /** 本段落起始泵码（接班/调价时的表底数，L） */
  startReading: string;
  /** 本段结束泵码（再次调价/交班时的表底数，L） */
  endReading: string;
  /** 本段执行单价（元/L） */
  price: string;
}

export type TimelineEventKind =
  | "create"
  | "save"
  | "submit"
  | "approve"
  | "reject"
  | "correct"
  | "freeze";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  at: string;
  actor: string;
  note?: string;
}

/** 一次冻结订正保留的旧金额留痕 */
export interface CorrectionEntry {
  id: string;
  reason: string;
  at: string;
  actor: string;
  /** 订正前的整班应收（冻结金额） */
  oldReceivable: number;
  /** 订正前现金 */
  oldCash: number;
  /** 订正前电子支付 */
  oldDigital: number;
  /** 订正后整班应收（重新送审时的金额） */
  newReceivable: number;
  newCash: number;
  newDigital: number;
  /** 明细字段级变化，供凭证上逐条展示 */
  changes: string[];
  /** 站长复核本次订正后由 correct 转 frozen */
  closedAt?: string;
}

export interface Shift {
  id: string;
  /** 凭证号：复核通过冻结时生成，如 PZ-20260925-001 */
  voucherNo?: string;
  station: string;
  shiftDate: string;
  shift: ShiftName;
  operator: string;
  manager: string;

  /** 接班时各油品起泵码，按油品名记录，供价格段逐段衔接校验 */
  openingReadings: Record<string, string>;

  segments: PriceSegment[];
  cash: string;
  digital: string;

  /** 长短款原因：差异不为 0 时必填，否则不允许送站长复核 */
  varianceReason: string;

  status: ShiftStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  frozenAt?: string;
  approvedBy?: string;

  /** 冻结时的整班快照；打开冻结凭证发起订正时用它恢复现场 */
  frozenSnapshot?: Shift;

  corrections: CorrectionEntry[];
  timeline: TimelineEvent[];
}

export interface SegmentSummary {
  segment: PriceSegment;
  volume: number;
  amount: number;
  gap: boolean;
}

export interface FuelSummary {
  fuel: string;
  volume: number;
  amount: number;
}

export interface ShiftSummary {
  bySegment: SegmentSummary[];
  byFuel: FuelSummary[];
  totalVolume: number;
  receivable: number;
  cash: number;
  digital: number;
  paid: number;
  variance: number;
}

export interface Issue {
  segmentId?: string;
  message: string;
}

export interface Settings {
  station: string;
  fuels: string[];
  operator: string;
  manager: string;
}

export interface StoreState {
  version: number;
  shifts: Shift[];
  settings: Settings;
}
