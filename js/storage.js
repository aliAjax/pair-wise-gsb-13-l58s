/**
 * storage.js —— 本地存储层
 *
 * 只与 localStorage 打交道：班次凭证、当前身份、编辑草稿、种子数据。
 * 不含任何页面/DOM 逻辑；金额派生交给 Rules，这里只持久化原始录入与快照。
 */
(function (global) {
  "use strict";

  var KEY_SHIFTS = "gas-shift-handover:v1";
  var KEY_ROLE = "gas-shift-handover:role";
  var KEY_DRAFTS = "gas-shift-handover:drafts:v1";

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  /* -------------------------------- 班次 -------------------------------- */

  function getShifts() {
    var shifts = readJSON(KEY_SHIFTS, null);
    if (shifts === null) {
      shifts = buildSeeds();
      writeJSON(KEY_SHIFTS, shifts);
    }
    return shifts;
  }

  function getShift(id) {
    return getShifts().filter(function (s) { return s.id === id; })[0] || null;
  }

  function upsertShift(shift) {
    var shifts = getShifts();
    var idx = -1;
    shifts.forEach(function (s, i) { if (s.id === shift.id) idx = i; });
    if (idx >= 0) shifts[idx] = shift;
    else shifts.unshift(shift);
    writeJSON(KEY_SHIFTS, shifts);
  }

  function removeShift(id) {
    writeJSON(KEY_SHIFTS, getShifts().filter(function (s) { return s.id !== id; }));
  }

  // 凭证序号：同一天内递增
  function nextVoucherCode(date) {
    var ymd = String(date).replace(/-/g, "");
    var prefix = "PZ-" + ymd + "-";
    var max = 0;
    getShifts().forEach(function (s) {
      if (s.code && s.code.indexOf(prefix) === 0) {
        var n = parseInt(s.code.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
    return prefix + String(max + 1).padStart(3, "0");
  }

  /* -------------------------------- 身份 -------------------------------- */

  function getRole() {
    return readJSON(KEY_ROLE, "attendant") === "manager" ? "manager" : "attendant";
  }

  function setRole(role) {
    writeJSON(KEY_ROLE, role === "manager" ? "manager" : "attendant");
  }

  /* -------------------------------- 草稿 -------------------------------- */

  function getDrafts() {
    return readJSON(KEY_DRAFTS, {}) || {};
  }

  function getDraft(id) {
    var d = getDrafts();
    return d[id] || null;
  }

  function saveDraft(id, shift) {
    var d = getDrafts();
    d[id] = shift;
    writeJSON(KEY_DRAFTS, d);
  }

  function clearDraft(id) {
    var d = getDrafts();
    if (d[id]) {
      delete d[id];
      writeJSON(KEY_DRAFTS, d);
    }
  }

  /* ------------------------------ 种子数据 ------------------------------ */

  function seg(id, fuel, pump, s, e, price) {
    return { id: id, fuel: fuel, pump: pump, meterStart: s, meterEnd: e, priceYuan: price };
  }

  // 构造一个已通过复核的冻结班次，并内建一条“已通过的订正”记录，
  // 用来直观展示旧金额、旧时间、订正原因如何留痕。
  function buildFrozenSeed() {
    var R = global.Rules;
    var shift = {
      id: "seed-frozen-1",
      code: "PZ-20260924-001",
      date: "2026-09-24",
      shiftType: "早班",
      attendant: "王芳",
      cashYuan: "6100.00",
      digitalYuan: "18502.35",
      varianceReason: "交班时点现金少100元，初判顾客少付",
      segments: [
        seg("s1", "92#汽油", "01", "12500.00", "14280.50", "7.65"),
        seg("s2", "92#汽油", "01", "14280.50", "14900.00", "7.85"), // 调价后第二段
        seg("s3", "95#汽油", "03", "8600.00", "9360.20", "8.18")
      ],
      status: R.STATUS.FROZEN,
      corrections: [],
      logs: []
    };

    var before = R.snapshot(shift); // 订正前：少 100 元
    before.at = "2026-09-24T15:20:00";

    // 订正：补缴 100 元现金，长短款清零
    shift.cashYuan = "6200.00";
    shift.varianceReason = "";
    shift.reviewer = "站长·周强";
    shift.reviewedAt = "2026-09-24T15:26:00";
    shift.reviewComment = "监控核对无误，订正通过";
    shift.frozenAt = "2026-09-24T15:26:00";
    shift.submittedAt = "2026-09-24T15:18:00";
    shift.submitActor = "王芳";
    shift.frozenSnapshot = R.snapshot(shift);
    shift.frozenSnapshot.at = "2026-09-24T15:26:00";

    var afterSnap = R.snapshot(shift);
    afterSnap.at = "2026-09-24T15:26:00";
    shift.corrections.push({
      at: "2026-09-24T15:21:00",
      actor: "王芳",
      reason: "核对监控确认顾客少付100元，顾客已返回补缴现金100元",
      before: before,
      after: afterSnap,
      approvedAt: "2026-09-24T15:26:00",
      approver: "站长·周强"
    });

    R.addLog(shift, "建班", "王芳", "");
    R.addLog(shift, "送站长复核", "王芳", "");
    R.addLog(shift, "复核通过，整班冻结", "站长·周强", "首次冻结");
    R.addLog(shift, "发起订正（冻结凭证保留只读）", "王芳", "补缴现金100元");
    R.addLog(shift, "订正通过，凭证重新冻结", "站长·周强", "监控核对无误");
    return shift;
  }

  function buildSeeds() {
    var R = global.Rules;

    var frozen = buildFrozenSeed();

    // 待复核：班中柴油调价两段，泵码接续，长短款 -46.40 已写原因
    var pending = {
      id: "seed-pending-1",
      code: "PZ-20260925-001",
      date: "2026-09-25",
      shiftType: "中班",
      attendant: "李强",
      cashYuan: "3420.50",
      digitalYuan: "15491.00",
      varianceReason: "16:40一辆货车电子支付少扫46.40元，司机已离场，已报值班经理并登记车牌",
      segments: [
        seg("p1", "0#柴油", "05", "22000.00", "23812.40", "7.24"),
        seg("p2", "0#柴油", "05", "23812.40", "24600.00", "7.41") // 15:00 调价
      ],
      status: R.STATUS.PENDING_REVIEW,
      submittedAt: "2026-09-25T15:05:00",
      submitActor: "李强",
      corrections: [],
      logs: []
    };
    R.addLog(pending, "建班", "李强", "");
    R.addLog(pending, "送站长复核", "李强", "");

    // 草稿：两段泵码差 0.50 升接不上 → 留在待修正
    var draft = {
      id: "seed-draft-1",
      code: "",
      date: "2026-09-25",
      shiftType: "晚班",
      attendant: "赵敏",
      cashYuan: "",
      digitalYuan: "",
      varianceReason: "",
      segments: [
        seg("d1", "92#汽油", "02", "9800.00", "10560.30", "7.85"),
        seg("d2", "92#汽油", "02", "10560.80", "11120.00", "7.85") // 起始码 10560.80 ≠ 上段止码 10560.30
      ],
      status: R.STATUS.DRAFT,
      corrections: [],
      logs: []
    };
    R.addLog(draft, "建班", "赵敏", "");

    return [draft, pending, frozen];
  }

  global.Storage = {
    getShifts: getShifts,
    getShift: getShift,
    upsertShift: upsertShift,
    removeShift: removeShift,
    nextVoucherCode: nextVoucherCode,
    getRole: getRole,
    setRole: setRole,
    getDraft: getDraft,
    saveDraft: saveDraft,
    clearDraft: clearDraft
  };
})(window);
