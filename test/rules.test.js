/**
 * test/rules.test.js —— 规则层状态机自测（零依赖，node test/rules.test.js）
 * 用内存垫片代替 localStorage，只验证 js/rules.js 的纯规则行为。
 */
const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};
global.window = global;

require("../js/rules.js");
const R = global.Rules;

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name); }
}

function baseShift() {
  return {
    id: "t1", code: "", date: "2026-09-25", shiftType: "晚班", attendant: "赵敏",
    cashYuan: "", digitalYuan: "", varianceReason: "",
    segments: [
      { id: "a", fuel: "92#汽油", pump: "02", meterStart: "100", meterEnd: "200", priceYuan: "7.85" },
      { id: "b", fuel: "92#汽油", pump: "02", meterStart: "200", meterEnd: "300", priceYuan: "7.95" }
    ],
    status: R.STATUS.DRAFT, corrections: [], logs: []
  };
}

// 1. 分段计价与接续
let s = baseShift();
let ev = R.evaluateShift(s);
ok("调价两段接续无待修正", ev.rows.every((r) => !r.ev.gap));
ok("应收 = 100*7.85 + 100*7.95 = 1580.00", ev.totalReceivableCents === 158000);

// 2. 泵码差 0.5L → 待修正，阻断送复核
s.segments.push({ id: "c", fuel: "92#汽油", pump: "02", meterStart: "300.5", meterEnd: "320", priceYuan: "7.95" });
ev = R.evaluateShift(s);
ok("泵码差 0.5L 标记待修正", ev.rows[2].ev.gap === true);
let pay = R.summarizePayments(s, ev);
ok("待修正 + 现金未填被拦截", R.validateForSubmit(s, ev, pay).some((e) => e.indexOf("接不上") >= 0) &&
  R.validateForSubmit(s, ev, pay).some((e) => e.indexOf("现金") >= 0));

// 3. 删除问题段后，短款必须写原因
s.segments.pop();
s.cashYuan = "1000";
s.digitalYuan = "560";
ev = R.evaluateShift(s);
pay = R.summarizePayments(s, ev);
ok("短款 20 元识别", pay.varianceCents === -2000);
ok("短款无原因被拦截", R.validateForSubmit(s, ev, pay).some((e) => e.indexOf("长短款") >= 0));
s.varianceReason = "顾客少付20元，车牌京A12345";
ok("写明原因后校验通过", R.validateForSubmit(s, ev, pay).length === 0);

// 4. 送复核 → 退回 → 再送 → 通过冻结
R.submit(s, "营业员·赵敏");
ok("送复核状态", s.status === R.STATUS.PENDING_REVIEW);
R.reject(s, "站长·周强", "请补充车牌");
ok("退回为草稿且保留意见", s.status === R.STATUS.DRAFT && s.reviewComment === "请补充车牌");
R.submit(s, "营业员·赵敏");
R.approve(s, "站长·周强", "通过");
ok("通过后冻结为凭证", s.status === R.STATUS.FROZEN && !!s.frozenSnapshot && !!s.frozenAt);
ok("冻结快照记录旧差异 -20.00", s.frozenSnapshot.varianceCents === -2000);
ok("冻结后不可编辑", R.isEditable(s) === false);

// 5. 订正：补缴 20 元，旧金额/时间留痕，再复核重新冻结
R.requestCorrection(s, "营业员·赵敏", "顾客返回补缴20元现金");
ok("进入订正中且旧快照保留", s.status === R.STATUS.CORRECTING && s.frozenSnapshot.varianceCents === -2000);
s.cashYuan = "1020";
s.varianceReason = "";
ev = R.evaluateShift(s);
pay = R.summarizePayments(s, ev);
ok("订正后差异为 0", pay.varianceCents === 0);
R.submitCorrection(s, "营业员·赵敏");
ok("订正待复核", s.status === R.STATUS.PENDING_CORRECTION);
R.approveCorrection(s, "站长·周强", "属实");
ok("订正通过重新冻结", s.status === R.STATUS.FROZEN);
const c = s.corrections[0];
ok("订正保留旧金额 -20.00", c.before.varianceCents === -2000);
ok("订正记录新金额 0.00", c.after.varianceCents === 0);
ok("旧时间与通过时间均留痕", !!c.before.at && !!c.at && !!c.approvedAt);
ok("现金旧值 1000 / 新值 1020", c.before.cashCents === 100000 && c.after.cashCents === 102000);

// 6. 订正被退回 → 放弃 → 按冻结快照恢复
R.requestCorrection(s, "营业员·赵敏", "测试");
s.digitalYuan = "999";
R.submitCorrection(s, "营业员·赵敏");
R.reject(s, "站长·周强", "不成立");
ok("订正退回回到订正中", s.status === R.STATUS.CORRECTING && s.frozenSnapshot.digitalCents === 56000);
s.corrections.pop();
s.cashYuan = R.centsToYuan(s.frozenSnapshot.cashCents);
s.digitalYuan = R.centsToYuan(s.frozenSnapshot.digitalCents);
s.status = R.STATUS.FROZEN;
ev = R.evaluateShift(s);
pay = R.summarizePayments(s, ev);
ok("放弃订正后金额还原", pay.varianceCents === 0);

// 7. 录入边界
const s2 = {
  id: "t2", date: "2026-09-25", shiftType: "早班", attendant: "X",
  cashYuan: "1", digitalYuan: "1", varianceReason: "",
  segments: [
    { id: "z", fuel: "92#汽油", pump: "1", meterStart: "20", meterEnd: "10", priceYuan: "7.8" },
    { id: "y", fuel: "", pump: "", meterStart: "", meterEnd: "", priceYuan: "" }
  ],
  status: R.STATUS.DRAFT, corrections: [], logs: []
};
const ev2 = R.evaluateShift(s2);
const pay2 = R.summarizePayments(s2, ev2);
const errs2 = R.validateForSubmit(s2, ev2, pay2);
ok("止码小于起始码被拦截", errs2.some((e) => e.indexOf("止码不能小于起始码") >= 0));
ok("空白段被拦截", errs2.some((e) => e.indexOf("空白段") >= 0));

console.log("\n规则层自测：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
