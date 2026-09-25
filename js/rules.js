/**
 * rules.js —— 业务规则层（纯函数）
 *
 * 只负责一件事：给定班次数据，算出派生结果与判定结论。
 * 不读写 DOM、不读写 localStorage，可被交互层直接调用，也方便以后替换成接口校验。
 *
 * 金额在存储层一律以「分」（整数）保存；泵码以「升」为单位，最多保留 2 位小数。
 *
 * 数据模型：
 *   Shift {
 *     id, code(凭证编号), date, shiftType, attendant,
 *     cashCents, digitalCents, varianceReason,
 *     segments: Segment[],
 *     status: 'draft' | 'pending_review' | 'frozen' | 'correcting' | 'pending_correction',
 *     frozenAt, frozenSnapshot,                 // 通过复核后冻结
 *     submittedAt, submitActor,                 // 最近一次送复核
 *     reviewer, reviewedAt, reviewComment,      // 复核意见（退回/通过）
 *     corrections: Correction[],                // 每次订正的旧金额、原因、时间
 *     logs: LogEntry[]
 *   }
 *   Segment { id, fuel, pump, meterStart, meterEnd, priceYuan }
 *   Correction { at, actor, reason, before: 快照, after: 快照, approvedAt }
 */
(function (global) {
  "use strict";

  var FUELS = ["92#汽油", "95#汽油", "98#汽油", "0#柴油"];
  var SHIFT_TYPES = ["早班", "中班", "晚班"];

  // draft 仅营业员可见；其余状态两身份都可见
  var STATUS = {
    DRAFT: "draft",
    PENDING_REVIEW: "pending_review",
    FROZEN: "frozen",
    CORRECTING: "correcting",
    PENDING_CORRECTION: "pending_correction"
  };

  var STATUS_LABEL = {
    draft: "草稿",
    pending_review: "待站长复核",
    frozen: "已冻结凭证",
    correcting: "待修正（订正中）",
    pending_correction: "订正待复核"
  };

  /* ------------------------------ 基础工具 ------------------------------ */

  function uid() {
    return (
      "id-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 9)
    );
  }

  // 元（输入框字符串/数字）→ 分（整数）。非法返回 null。
  function yuanToCents(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    var n = Number(value);
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  function centsToYuan(cents) {
    return (cents / 100).toFixed(2);
  }

  // 带千分位的展示金额，如 21,080.00
  function formatMoney(cents) {
    return Number(centsToYuan(cents)).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // 带正负号的长短款
  function formatSigned(cents) {
    var sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
    return sign + formatMoney(Math.abs(cents));
  }

  // 泵码 → 升（最多 2 位小数）。空值返回 null，非法返回 NaN。
  function parseMeter(value) {
    var s = String(value === null || value === undefined ? "" : value).trim();
    if (s === "") return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Number(s);
  }

  function formatMeter(v) {
    return v === null || v === undefined || isNaN(v) ? "—" : Number(v).toFixed(2);
  }

  function formatTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  function groupKey(seg) {
    return (seg.fuel || "未选油品") + "@" + (String(seg.pump || "").trim() || "未填泵号");
  }

  function groupLabel(key) {
    var parts = key.split("@");
    return parts[0] + " · " + parts[1] + "号枪";
  }

  /* --------------------------- 单个价格段判定 --------------------------- */

  /**
   * 评估单个价格段。
   * @param {object} seg      价格段
   * @param {object} prev     同组（同油品+同泵）按起始码排序后的上一段
   * @returns {{issues: string[], gap: boolean, volume: number, amountCents: number|null,
   *            empty: boolean, start: number|null, end: number|null, priceCents: number|null}}
   *  issues：录入/逻辑错误（红色）；gap：与上一段泵码接不上（进入待修正，阻断送复核）
   */
  function evaluateSegment(seg, prev) {
    var issues = [];
    var start = parseMeter(seg.meterStart);
    var end = parseMeter(seg.meterEnd);
    var priceCents = yuanToCents(seg.priceYuan);
    var fuelOk = !!seg.fuel;
    var pumpOk = String(seg.pump || "").trim() !== "";

    var empty =
      !seg.fuel &&
      String(seg.pump || "").trim() === "" &&
      String(seg.meterStart || "").trim() === "" &&
      String(seg.meterEnd || "").trim() === "" &&
      String(seg.priceYuan || "").trim() === "";

    if (!empty) {
      if (!fuelOk) issues.push("未选油品");
      if (!pumpOk) issues.push("未填泵号");
      if (start === null) issues.push("缺起始泵码");
      else if (isNaN(start)) issues.push("起始泵码格式错误（数字，最多两位小数）");
      if (end === null) issues.push("缺止码");
      else if (isNaN(end)) issues.push("止码格式错误（数字，最多两位小数）");
      if (priceCents === null) issues.push("单价缺失或非法");
      if (start !== null && !isNaN(start) && end !== null && !isNaN(end) && end < start) {
        issues.push("止码不能小于起始码");
      }
    }

    var gap = false;
    // 接续校验只看泵码本身，不受其他字段是否填全影响
    if (prev) {
      var prevEnd = parseMeter(prev.meterEnd);
      if (start !== null && !isNaN(start) && prevEnd !== null && !isNaN(prevEnd)) {
        if (Math.abs(start - prevEnd) > 1e-9) {
          gap = true;
          issues.push("泵码接不上：起始码 " + formatMeter(start) + " ≠ 上段止码 " + formatMeter(prevEnd));
        }
      }
    }

    var volume = 0;
    var amountCents = null;
    var rangesOk = start !== null && !isNaN(start) && end !== null && !isNaN(end) && end >= start;
    if (rangesOk) {
      volume = Math.round((end - start) * 100) / 100;
      if (priceCents !== null) {
        amountCents = Math.round(volume * priceCents);
      }
    }

    return {
      issues: issues,
      gap: gap,
      empty: empty,
      volume: volume,
      amountCents: amountCents,
      start: start === null || isNaN(start) ? null : start,
      end: end === null || isNaN(end) ? null : end,
      priceCents: priceCents
    };
  }

  /* ------------------------------ 整班评估 ------------------------------ */

  /**
   * 评估整班：分组排序、接续校验、应收汇总。
   * @returns {{
   *   rows: Array, groups: Array, totalReceivableCents: number|null,
   *   totalVolume: number, hasSegments: boolean
   * }}
   * rows 与 shift.segments 顺序一一对应（保留营业员的录入顺序，仅在同组内按起始码找“上一段”）。
   * 当任何一段无法计价时 totalReceivableCents 为 null（表示应收尚算不出）。
   */
  function evaluateShift(shift) {
    var segments = shift.segments || [];

    // 同组内按起始码排序（空/非法起始码排最后），用来确定泵码先后
    var buckets = {};
    segments.forEach(function (seg) {
      var key = groupKey(seg);
      (buckets[key] = buckets[key] || []).push(seg);
    });
    Object.keys(buckets).forEach(function (key) {
      buckets[key].sort(function (a, b) {
        var va = parseMeter(a.meterStart);
        var vb = parseMeter(b.meterStart);
        va = va === null || isNaN(va) ? Infinity : va;
        vb = vb === null || isNaN(vb) ? Infinity : vb;
        return va - vb;
      });
    });

    // 按泵码先后建立 段id → 上一段 的映射（同一物理泵码必须首尾相接）
    var prevById = {};
    Object.keys(buckets).forEach(function (key) {
      buckets[key].forEach(function (seg, i) {
        if (i > 0) prevById[seg.id] = buckets[key][i - 1];
      });
    });

    var rows = segments.map(function (seg) {
      var ev = evaluateSegment(seg, prevById[seg.id] || null);
      return { seg: seg, key: groupKey(seg), ev: ev };
    });

    var groups = Object.keys(buckets).map(function (key) {
      var groupRows = rows.filter(function (r) { return r.key === key; });
      var valid = groupRows.filter(function (r) { return r.ev.amountCents !== null; });
      var gapRows = groupRows.filter(function (r) { return r.ev.gap; });
      var issueRows = groupRows.filter(function (r) { return !r.ev.empty && r.ev.issues.length > 0; });
      return {
        key: key,
        label: groupLabel(key),
        fuel: buckets[key][0].fuel || "",
        volume: valid.reduce(function (s, r) { return s + r.ev.volume; }, 0),
        amountCents: valid.reduce(function (s, r) { return s + r.ev.amountCents; }, 0),
        counted: valid.length,
        total: groupRows.length,
        hasGap: gapRows.length > 0,
        hasIssue: issueRows.length > 0
      };
    });
    groups.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });

    var allEvaluable = segments.length > 0 && rows.every(function (r) { return r.ev.amountCents !== null; });
    var totalReceivableCents = allEvaluable
      ? rows.reduce(function (s, r) { return s + r.ev.amountCents; }, 0)
      : null;
    var totalVolume = rows
      .filter(function (r) { return r.ev.amountCents !== null; })
      .reduce(function (s, r) { return s + r.ev.volume; }, 0);

    return {
      rows: rows,
      groups: groups,
      totalReceivableCents: totalReceivableCents,
      totalVolume: Math.round(totalVolume * 100) / 100,
      hasSegments: segments.length > 0
    };
  }

  /**
   * 现金 / 电子支付 / 长短款汇总。
   * @returns {{cashCents:number|null, digitalCents:number|null, paidCents:number|null,
   *            varianceCents:number|null}}
   * 支付缺填或非法 → null（不能参与汇总，阻断送复核）
   */
  function summarizePayments(shift, evaluation) {
    var cashCents = yuanToCents(shift.cashYuan);
    var digitalCents = yuanToCents(shift.digitalYuan);
    var paidCents = null;
    var varianceCents = null;
    if (cashCents !== null && digitalCents !== null) {
      paidCents = cashCents + digitalCents;
      if (evaluation.totalReceivableCents !== null) {
        varianceCents = paidCents - evaluation.totalReceivableCents;
      }
    }
    return { cashCents: cashCents, digitalCents: digitalCents, paidCents: paidCents, varianceCents: varianceCents };
  }

  /* ------------------------------ 送复核校验 ----------------------------- */

  /**
   * 送站长复核前的全部硬性校验。返回错误文案数组：空数组 = 允许送出。
   * 规则：
   *  1. 班次日期/班次/营业员必填；
   *  2. 至少一个价格段，不允许保留空白段；
   *  3. 每段油品、泵号、起止码、单价齐全且止码≥起始码；
   *  4. 同油品同泵相邻段泵码必须接续，接不上留在待修正；
   *  5. 现金、电子支付必须填写合法金额；
   *  6. 有长短款（差异 ≠ 0）必须写明原因。
   */
  function validateForSubmit(shift, evaluation, summary) {
    var errors = [];

    if (!shift.date) errors.push("请选择班次日期");
    if (!shift.shiftType) errors.push("请选择班次（早/中/晚班）");
    if (!String(shift.attendant || "").trim()) errors.push("请填写当班营业员");

    if (!evaluation.hasSegments) {
      errors.push("至少需要填写一个价格段");
    } else {
      evaluation.rows.forEach(function (r, i) {
        if (r.ev.empty) {
          errors.push("第 " + (i + 1) + " 段为空白段，请补全或删除");
          return;
        }
        r.ev.issues.forEach(function (msg) {
          errors.push("第 " + (i + 1) + " 段：" + msg);
        });
      });
    }

    if (summary.cashCents === null) errors.push("现金收入未填写或金额非法");
    if (summary.digitalCents === null) errors.push("电子支付未填写或金额非法");

    if (summary.varianceCents !== null && summary.varianceCents !== 0) {
      if (!String(shift.varianceReason || "").trim()) {
        errors.push("存在长短款 " + formatSigned(summary.varianceCents) + " 元，必须写明原因后才能送站长复核");
      }
    }

    return errors;
  }

  /* --------------------------- 状态流转（纯函数） -------------------------- */

  function addLog(shift, action, actor, detail) {
    shift.logs = shift.logs || [];
    shift.logs.unshift({ at: new Date().toISOString(), action: action, actor: actor, detail: detail || "" });
  }

  // 营业员送复核（草稿 / 退回后的待修正 → 待复核）
  function submit(shift, actor) {
    shift.status = STATUS.PENDING_REVIEW;
    shift.submittedAt = new Date().toISOString();
    shift.submitActor = actor;
    addLog(shift, "送站长复核", actor, "");
  }

  // 站长复核通过：整班冻结成只读凭证
  function approve(shift, actor, comment) {
    shift.status = STATUS.FROZEN;
    shift.reviewer = actor;
    shift.reviewedAt = new Date().toISOString();
    shift.reviewComment = comment || "通过";
    shift.frozenAt = new Date().toISOString();
    shift.frozenSnapshot = snapshot(shift);
    addLog(shift, "复核通过，整班冻结", actor, comment || "");
  }

  // 站长退回：普通班次 → 待修正；订正复核退回 → 订正中
  function reject(shift, actor, comment) {
    if (shift.status === STATUS.PENDING_CORRECTION) {
      shift.status = STATUS.CORRECTING;
      addLog(shift, "订正复核未通过，退回修正", actor, comment);
    } else {
      shift.status = STATUS.DRAFT;
      addLog(shift, "复核未通过，退回修正", actor, comment);
    }
    shift.reviewer = actor;
    shift.reviewedAt = new Date().toISOString();
    shift.reviewComment = comment;
  }

  // 营业员从待复核撤回（站长尚未处理）
  function withdraw(shift, actor) {
    if (shift.status === STATUS.PENDING_CORRECTION) {
      shift.status = STATUS.CORRECTING;
      addLog(shift, "撤回订正", actor, "");
    } else {
      shift.status = STATUS.DRAFT;
      addLog(shift, "撤回复核", actor, "");
    }
  }

  /**
   * 对冻结凭证发起订正：冻结数据原样保留（frozenSnapshot 不动），
   * 班次进入“订正中”，营业员在副本上修改。
   */
  function requestCorrection(shift, actor, reason) {
    shift.corrections = shift.corrections || [];
    shift.corrections.push({
      at: new Date().toISOString(),
      actor: actor,
      reason: reason,
      before: shift.frozenSnapshot || snapshot(shift),
      after: null,
      approvedAt: null
    });
    shift.status = STATUS.CORRECTING;
    addLog(shift, "发起订正（冻结凭证保留只读）", actor, reason);
  }

  // 订正送复核
  function submitCorrection(shift, actor) {
    shift.status = STATUS.PENDING_CORRECTION;
    shift.submittedAt = new Date().toISOString();
    shift.submitActor = actor;
    addLog(shift, "订正送站长复核", actor, "");
  }

  // 订正复核通过：登记旧金额/时间与新快照，重新冻结
  function approveCorrection(shift, actor, comment) {
    var c = shift.corrections[shift.corrections.length - 1];
    c.approvedAt = new Date().toISOString();
    c.approver = actor;
    c.after = snapshot(shift);
    shift.status = STATUS.FROZEN;
    shift.reviewer = actor;
    shift.reviewedAt = new Date().toISOString();
    shift.reviewComment = comment || "订正通过";
    shift.frozenAt = new Date().toISOString();
    shift.frozenSnapshot = snapshot(shift);
    addLog(shift, "订正通过，凭证重新冻结", actor, comment || "");
  }

  // 当前是否可编辑（只读凭证一律 false）
  function isEditable(shift) {
    return shift.status === STATUS.DRAFT || shift.status === STATUS.CORRECTING;
  }

  // 快照：冻结/订正时记录“当时”的全部金额与明细
  function snapshot(shift) {
    var ev = evaluateShift(shift);
    var pay = summarizePayments(shift, ev);
    return {
      at: new Date().toISOString(),
      date: shift.date,
      shiftType: shift.shiftType,
      attendant: shift.attendant,
      segments: shift.segments.map(function (s) {
        var row = ev.rows.filter(function (r) { return r.seg.id === s.id; })[0];
        return {
          fuel: s.fuel,
          pump: String(s.pump || "").trim(),
          meterStart: s.meterStart,
          meterEnd: s.meterEnd,
          priceYuan: s.priceYuan,
          volume: row ? row.ev.volume : 0,
          amountCents: row ? row.ev.amountCents : null
        };
      }),
      totalReceivableCents: ev.totalReceivableCents,
      cashCents: pay.cashCents,
      digitalCents: pay.digitalCents,
      paidCents: pay.paidCents,
      varianceCents: pay.varianceCents,
      varianceReason: shift.varianceReason || ""
    };
  }

  // 凭证编号：PZ-年月日-序号
  function buildVoucherCode(date, seq) {
    var ymd = String(date || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
    return "PZ-" + ymd + "-" + String(seq).padStart(3, "0");
  }

  global.Rules = {
    FUELS: FUELS,
    SHIFT_TYPES: SHIFT_TYPES,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    uid: uid,
    yuanToCents: yuanToCents,
    centsToYuan: centsToYuan,
    formatMoney: formatMoney,
    formatSigned: formatSigned,
    parseMeter: parseMeter,
    formatMeter: formatMeter,
    formatTime: formatTime,
    groupKey: groupKey,
    groupLabel: groupLabel,
    evaluateSegment: evaluateSegment,
    evaluateShift: evaluateShift,
    summarizePayments: summarizePayments,
    validateForSubmit: validateForSubmit,
    submit: submit,
    approve: approve,
    reject: reject,
    withdraw: withdraw,
    requestCorrection: requestCorrection,
    submitCorrection: submitCorrection,
    approveCorrection: approveCorrection,
    isEditable: isEditable,
    snapshot: snapshot,
    buildVoucherCode: buildVoucherCode,
    addLog: addLog
  };
})(window);
