import {
  approve,
  approveCorrection,
  canSubmit,
  cloneShift,
  rejectCorrection,
  submitCorrection,
  submitForReview,
  summarize,
  validateShift,
} from "../src/rules.ts";
import type { Shift } from "../src/types.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL: " + name);
  passed++;
  console.log("ok -", name);
}

function makeShift(): Shift {
  const now = new Date().toISOString();
  return {
    id: "s1",
    station: "测试站",
    shiftDate: "2026-09-25",
    shift: "早班",
    operator: "甲",
    manager: "站长",
    openingReadings: { "92#": "1000", "95#": "2000" },
    segments: [
      { id: "g1", fuel: "92#", startReading: "1000", endReading: "1200", price: "7.8" },
      // 调价段：衔接
      { id: "g2", fuel: "92#", startReading: "1200", endReading: "1300", price: "7.9" },
      { id: "g3", fuel: "95#", startReading: "2000", endReading: "2100", price: "8.4" },
    ],
    cash: "1000",
    digital: "",
    varianceReason: "",
    status: "editing",
    createdAt: now,
    updatedAt: now,
    corrections: [],
    timeline: [],
  };
}

// 1. 应收汇总：200*7.8 + 100*7.9 + 100*8.4 = 1560 + 790 + 840 = 3190
const s = makeShift();
let sum = summarize(s);
check("应收=3190", sum.receivable === 3190);
check("按油品 92#=2350", sum.byFuel.find((f) => f.fuel === "92#")!.amount === 2350);

// 2. 泵码接不上：第二段起点改错
const bad = makeShift();
bad.segments[1].startReading = "1210";
const issues = validateShift(bad);
check("接不上时产生校验问题", issues.some((i) => i.segmentId === "g2"));
check("汇总中该段标 gap", summarize(bad).bySegment.find((r) => r.segment.id === "g2")!.gap);
check("接不上不能送审", !canSubmit(bad).ok);

// 3. 长短款必须写原因：实收1000 < 应收3190
check("无原因不能送审", !canSubmit(s).ok);
try {
  submitForReview(cloneShift(s), "甲");
  check("无原因送审抛错", false);
} catch {
  check("无原因送审抛错", true);
}
s.cash = "3190";
s.digital = "0";
check("账实一致可送审", canSubmit(s).ok);
submitForReview(s, "甲");
check("状态=reviewing", s.status === "reviewing");

// 4. 站长通过 -> 冻结凭证
approve(s, "站长", [s]);
check("冻结", s.status === "frozen");
check("有凭证号", !!s.voucherNo);
check("有冻结快照", !!s.frozenSnapshot);
const frozenAmount = summarize(s).receivable;

// 5. 冻结后直接改：只读状态由界面保证；规则上直接订正：改单价 + 写原因
s.segments[0].price = "7.85"; // 应收 +10 = 3200，实收 3190 -> 短款 10
s.varianceReason = "调价文件执行时点记错，短款待核";
const beforeCorrect = cloneShift(s.frozenSnapshot!);
submitCorrection(s, "甲", "单价记错，按调价文件应为7.85");
check("订正后回 reviewing", s.status === "reviewing");
check("旧金额留痕=3190", s.corrections[0].oldReceivable === 3190);
check("新金额留痕=3200", s.corrections[0].newReceivable === 3200);
check("留痕时间为冻结后", !!s.corrections[0].at);
check("变更明细包含单价", s.corrections[0].changes.some((c) => c.includes("单价")));
check("订正后保留旧冻结快照(供驳回恢复)", !!s.frozenSnapshot);
check("订正待复核期间凭证号已摘下", !s.voucherNo);
void beforeCorrect;

// 6. 站长驳回订正 -> 恢复冻结金额
rejectCorrection(s, "站长", "调价文件不适用本班");
check("驳回订正后恢复 frozen", s.status === "frozen");
check("恢复旧应收3190", summarize(s).receivable === 3190);
check("驳回后单价复原", s.segments[0].price === "7.8");
check("留痕条目关闭", !!s.corrections[0].closedAt);
check("留痕保留驳回原因", s.corrections[0].reason.includes("调价文件不适用"));
check("驳回后凭证号恢复", !!s.voucherNo);
check("驳回恢复后仍有冻结快照可再次订正", !!s.frozenSnapshot);
check("快照不嵌套自身快照", s.frozenSnapshot?.frozenSnapshot === undefined);

// 7. 再次订正并通过（现金补齐到 3200，账实一致）
s.segments[0].price = "7.85";
s.cash = "3200";
s.varianceReason = "";
submitCorrection(s, "甲", "二次订正");
approveCorrection(s, "站长", [s]);
check("订正复核通过重新冻结", s.status === "frozen");
check("新冻结金额3200", summarize(s).receivable === 3200);
check("订正条目已关闭", !!s.corrections[0].closedAt);
check("重新冻结的快照不嵌套", s.frozenSnapshot?.frozenSnapshot === undefined);
check("快照中保留两条订正留痕", s.frozenSnapshot?.corrections.length === 2);
check("时间线包含订正事件", s.timeline.some((t) => t.kind === "correct"));
void frozenAmount;

console.log(`\n${passed} checks passed`);
