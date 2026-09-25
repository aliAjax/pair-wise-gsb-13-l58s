/**
 * app.js —— 页面交互层
 *
 * 只负责视图渲染与事件：路由（hash）、角色切换、录入、送复核/复核/订正流程。
 * 业务判定一律调用 Rules.*，持久化一律调用 Storage.*。
 */
(function () {
  "use strict";

  var R = window.Rules;
  var S = window.Storage;

  var state = {
    role: S.getRole(),
    filter: "all",
    editing: null // { mode:'edit'|'readonly', shift:Shift, id:String }
  };

  /* ================================ 小工具 ================================ */

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function moneyOr(cents, placeholder) {
    return cents === null ? placeholder : R.formatMoney(cents);
  }

  function toast(msg, ok) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast show " + (ok === false ? "err" : "ok");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = "toast"; }, 2600);
  }

  function go(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  function statusPill(status) {
    var cls = {
      draft: "st-draft",
      pending_review: "st-review",
      frozen: "st-frozen",
      correcting: "st-correcting",
      pending_correction: "st-review"
    }[status] || "";
    return '<span class="pill ' + cls + '">' + R.STATUS_LABEL[status] + "</span>";
  }

  // 列表/筛选用的状态归类
  function category(status) {
    if (status === R.STATUS.DRAFT) return "open";
    if (status === R.STATUS.FROZEN) return "frozen";
    return "review"; // pending_review / correcting / pending_correction
  }

  /* ================================ 路由 ================================ */

  function parseRoute() {
    var h = (location.hash || "#/list").replace(/^#/, "");
    if (h.indexOf("/shift/") === 0) return { name: "shift", id: decodeURIComponent(h.slice(7)) };
    return { name: "list" };
  }

  function render() {
    syncRoleButtons();
    var route = parseRoute();
    var view = document.getElementById("view");
    if (route.name === "shift") {
      view.innerHTML = renderEditor(route.id);
      bindEditor();
      refreshDerived();
    } else {
      state.editing = null;
      view.innerHTML = renderList();
      bindList();
    }
  }

  window.addEventListener("hashchange", render);

  /* ================================ 列表页 ================================ */

  function visibleShifts() {
    var shifts = S.getShifts();
    return shifts.filter(function (s) {
      // 未送复核的草稿只有营业员自己能看到
      if (s.status === R.STATUS.DRAFT && state.role === "manager") return false;
      return true;
    });
  }

  function renderList() {
    var shifts = visibleShifts();
    if (state.filter !== "all") {
      shifts = shifts.filter(function (s) { return category(s.status) === state.filter; });
    }
    function lastTime(x) {
      return x.submittedAt || (x.logs && x.logs[0] && x.logs[0].at) || "";
    }
    shifts.sort(function (a, b) {
      var ta = lastTime(a);
      var tb = lastTime(b);
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    });

    var reviewCount = visibleShifts().filter(function (s) { return category(s.status) === "review"; }).length;
    var frozenCount = visibleShifts().filter(function (s) { return s.status === R.STATUS.FROZEN; }).length;
    var openCount = visibleShifts().filter(function (s) { return category(s.status) === "open"; }).length;
    var frozenTotal = visibleShifts()
      .filter(function (s) { return s.status === R.STATUS.FROZEN; })
      .reduce(function (sum, s) {
        var ev = R.evaluateShift(s);
        return sum + (ev.totalReceivableCents || 0);
      }, 0);

    var chips = [
      ["all", "全部", visibleShifts().length],
      ["open", "草稿/待修正", openCount],
      ["review", "待复核", reviewCount],
      ["frozen", "冻结凭证", frozenCount]
    ];

    var cards = shifts.map(renderCard).join("") ||
      '<div class="empty-box">没有匹配的班次。' +
      (state.role === "attendant" ? '点击「新建班次」开始交班拆账。' : "暂无需要查看的班次。") +
      "</div>";

    return (
      '<div class="page">' +
        '<section class="stats">' +
          statCard("班次总数", visibleShifts().length, "") +
          statCard("待站长复核", reviewCount, reviewCount ? "warn" : "") +
          statCard("冻结凭证", frozenCount, "") +
          statCard("冻结凭证应收合计", "¥" + R.formatMoney(frozenTotal), "strong") +
        "</section>" +

        '<section class="panel">' +
          '<div class="panel-head">' +
            "<h2>班次列表</h2>" +
            (state.role === "attendant"
              ? '<button type="button" class="btn primary" data-action="new-shift">＋ 新建班次</button>'
              : '<span class="hint">站长身份：可复核与查看只读凭证，不能录入</span>') +
          "</div>" +
          '<div class="chips">' +
            chips.map(function (c) {
              return '<button type="button" class="chip ' + (state.filter === c[0] ? "on" : "") +
                '" data-filter="' + c[0] + '">' + c[1] + "（" + c[2] + "）</button>";
            }).join("") +
          "</div>" +
          '<div class="cards">' + cards + "</div>" +
        "</section>" +
      "</div>"
    );
  }

  function statCard(label, value, cls) {
    return '<article class="stat ' + (cls || "") + '"><span>' + label + "</span><strong>" +
      value + "</strong></article>";
  }

  function renderCard(s) {
    var ev = R.evaluateShift(s);
    var pay = R.summarizePayments(s, ev);
    var gapRows = ev.rows.filter(function (r) { return r.ev.gap; });
    var issues = ev.rows.some(function (r) { return !r.ev.empty && r.ev.issues.length; });

    var badge = "";
    if (s.status === R.STATUS.PENDING_REVIEW) badge = '<span class="tag tag-warn">待你复核</span>';
    if (s.status === R.STATUS.PENDING_CORRECTION) badge = '<span class="tag tag-warn">订正待复核</span>';
    if (gapRows.length) badge = '<span class="tag tag-danger">泵码接不上 · 待修正</span>';
    else if (issues && s.status === R.STATUS.DRAFT) badge = '<span class="tag tag-danger">有未修正项</span>';

    var varianceHtml = "";
    if (pay.varianceCents !== null) {
      var cls = pay.varianceCents === 0 ? "zero" : pay.varianceCents < 0 ? "short" : "over";
      var word = pay.varianceCents === 0 ? "账实一致" : (pay.varianceCents < 0 ? "短款 " : "长款 ") +
        R.formatMoney(Math.abs(pay.varianceCents));
      varianceHtml = '<span class="variance ' + cls + '">' + word + "</span>";
    }

    return (
      '<article class="card" data-open="' + esc(s.id) + '">' +
        '<div class="card-top">' +
          "<div>" +
            '<div class="card-title">' + esc(s.date) + " " + esc(s.shiftType || "未选班次") + "</div>" +
            '<div class="card-sub">凭证 ' + esc(s.code || "保存后生成") + " · 营业员 " + esc(s.attendant || "未填") + "</div>" +
          "</div>" +
          "<div>" + statusPill(s.status) + badge + "</div>" +
        "</div>" +
        '<div class="card-metrics">' +
          "<span>价格段 <b>" + s.segments.length + "</b> 段</span>" +
          "<span>加油量 <b>" + ev.totalVolume.toFixed(2) + "</b> L</span>" +
          "<span>应收 <b>¥" + moneyOr(ev.totalReceivableCents, "待修正") + "</b></span>" +
          "<span>实收 <b>¥" + moneyOr(pay.paidCents, "未录入") + "</b></span>" +
          varianceHtml +
        "</div>" +
        (s.status === R.STATUS.FROZEN && s.corrections && s.corrections.length
          ? '<div class="card-foot">已订正 ' + s.corrections.length + " 次，旧金额与原因在凭证内留痕</div>"
          : "") +
      "</article>"
    );
  }

  function bindList() {
    document.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.getAttribute("data-filter");
        render();
      });
    });
    var newBtn = document.querySelector("[data-action='new-shift']");
    if (newBtn) newBtn.addEventListener("click", function () { go("#/shift/new"); });
    document.querySelectorAll("[data-open]").forEach(function (card) {
      card.addEventListener("click", function () { go("#/shift/" + encodeURIComponent(card.getAttribute("data-open"))); });
    });
  }

  /* ================================ 编辑页 ================================ */

  function blankShift() {
    return {
      id: R.uid(),
      code: "",
      date: new Date().toISOString().slice(0, 10),
      shiftType: "",
      attendant: "",
      cashYuan: "",
      digitalYuan: "",
      varianceReason: "",
      segments: [
        { id: R.uid(), fuel: "", pump: "", meterStart: "", meterEnd: "", priceYuan: "" }
      ],
      status: R.STATUS.DRAFT,
      corrections: [],
      logs: []
    };
  }

  function openShift(id) {
    var isNew = id === "new";
    var shift = null;
    var mode;

    if (isNew) {
      shift = S.getDraft("new") || blankShift();
      mode = "edit";
    } else {
      shift = S.getShift(id);
      if (!shift) return null;
      mode = R.isEditable(shift) ? "edit" : "readonly";
      // 站长在任何状态下都只能看
      if (state.role === "manager") mode = "readonly";
    }

    return { id: id, shift: shift, mode: mode };
  }

  function persistEditing() {
    var ed = state.editing;
    if (!ed || ed.mode !== "edit") return;
    if (ed.id === "new") {
      S.saveDraft("new", ed.shift);
    } else {
      S.upsertShift(ed.shift);
    }
  }

  function renderEditor(id) {
    var ed = openShift(id);
    if (!ed) {
      return '<div class="page"><div class="panel empty-box">班次不存在或已删除。<br>' +
        '<button type="button" class="btn" data-action="back">返回列表</button></div></div>';
    }
    state.editing = ed;
    var s = ed.shift;
    var editable = ed.mode === "edit";

    return (
      '<div class="page editor">' +
        '<div class="editor-bar">' +
          '<button type="button" class="btn" data-action="back">← 返回列表</button>' +
          '<div class="editor-bar-right">' +
            (s.code ? '<span class="voucher-no">凭证编号 ' + esc(s.code) + "</span>" : "") +
            statusPill(s.status) +
          "</div>" +
        "</div>" +

        renderBanners(s, editable) +

        (editable ? renderForm(s) : renderReadonly(s)) +

        renderCorrections(s) +
        renderLogs(s) +
        renderActions(s, editable) +
      "</div>"
    );
  }

  /* ---------------- 顶部提示：冻结/复核意见/订正中 ---------------- */

  function renderBanners(s, editable) {
    var html = "";
    if (s.status === R.STATUS.FROZEN) {
      html += banner("frozen",
        "🔒 只读凭证：已于 " + R.formatTime(s.frozenAt) + " 经 " + esc(s.reviewer || "站长") +
        " 复核通过并冻结。再次修改只能发起「订正」，旧金额与时间将原样保留。");
    }
    if (s.status === R.STATUS.CORRECTING) {
      var c = s.corrections[s.corrections.length - 1];
      html += banner("correcting",
        "订正中：冻结凭证保留只读，当前为可修改副本。订正原因：" + esc(c ? c.reason : "") +
        "。完成后需再次送站长复核。");
    }
    if (s.status === R.STATUS.PENDING_CORRECTION) {
      var pc = s.corrections[s.corrections.length - 1];
      html += banner("review",
        "订正已送复核（" + R.formatTime(s.submittedAt) + "）。订正原因：" + esc(pc ? pc.reason : ""));
    }
    if (s.status === R.STATUS.PENDING_REVIEW) {
      html += banner("review",
        "已送站长复核（" + R.formatTime(s.submittedAt) + "，送审人 " + esc(s.submitActor || "") + "）。复核通过后整班冻结。");
    }
    if ((s.status === R.STATUS.DRAFT || s.status === R.STATUS.CORRECTING) && s.reviewComment &&
        s.logs.some(function (l) { return l.action.indexOf("退回") >= 0; })) {
      html += banner("reject", "上次复核退回意见：" + esc(s.reviewComment));
    }
    return html;
  }

  function banner(kind, text) {
    return '<div class="banner banner-' + kind + '">' + text + "</div>";
  }

  /* ---------------- 录入表单（营业员可编辑） ---------------- */

  function metaInput(label, field, value, type, opts) {
    var input;
    if (type === "select") {
      input = '<select data-field="' + field + '">' +
        '<option value="">请选择</option>' +
        opts.map(function (o) {
          return '<option value="' + esc(o) + '"' + (o === value ? " selected" : "") + ">" + esc(o) + "</option>";
        }).join("") + "</select>";
    } else {
      var numeric = type === "number" || type === "date";
      input = '<input data-field="' + field + '" type="' + (type === "number" ? "text" : type || "text") +
        '" value="' + esc(value) + '"' + (numeric ? ' inputmode="decimal"' : "") + ">";
    }
    return "<label class=\"meta\"><span>" + label + "</span>" + input + "</label>";
  }

  function renderForm(s) {
    var rows = s.segments.map(function (seg, i) {
      var fuelOpts = R.FUELS.map(function (f) {
        return '<option value="' + esc(f) + '"' + (f === seg.fuel ? " selected" : "") + ">" + f + "</option>";
      }).join("");
      return (
        '<tr data-idx="' + i + '">' +
          '<td class="idx">' + (i + 1) + "</td>" +
          "<td><select data-field=\"fuel\"><option value=\"\">选油品</option>" + fuelOpts + "</select></td>" +
          '<td><input data-field="pump" value="' + esc(seg.pump) + '" placeholder="如 01" inputmode="numeric"></td>' +
          '<td><input data-field="meterStart" value="' + esc(seg.meterStart) + '" placeholder="起" inputmode="decimal"></td>' +
          '<td><input data-field="meterEnd" value="' + esc(seg.meterEnd) + '" placeholder="止" inputmode="decimal"></td>' +
          '<td><input data-field="priceYuan" value="' + esc(seg.priceYuan) + '" placeholder="元/L" inputmode="decimal"></td>' +
          '<td class="num seg-volume">—</td>' +
          '<td class="num seg-amount">—</td>' +
          '<td class="seg-status"></td>' +
          '<td><button type="button" class="btn mini danger" data-action="del-seg" data-idx="' + i + '">删</button></td>' +
        "</tr>"
      );
    }).join("");

    return (
      // 基础信息
      '<section class="panel">' +
        '<h3 class="block-title">班次信息</h3>' +
        '<div class="meta-grid">' +
          metaInput("班次日期", "date", s.date, "date") +
          metaInput("班次", "shiftType", s.shiftType, "select", R.SHIFT_TYPES) +
          metaInput("当班营业员", "attendant", s.attendant, "text") +
          '<label class="meta"><span>凭证编号</span><input value="保存并送复核后生成" disabled></label>' +
        "</div>" +
      "</section>" +

      // 价格段
      '<section class="panel">' +
        '<div class="panel-head"><h3 class="block-title">价格段拆账（同油品同泵按泵码先后接续）</h3>' +
          '<button type="button" class="btn" data-action="add-seg">＋ 添加价格段</button>' +
        "</div>" +
        '<div id="gap-alert"></div>' +
        '<div class="table-wrap">' +
        '<table class="grid">' +
          "<thead><tr>" +
            "<th>#</th><th>油品</th><th>泵号</th><th>起始泵码(L)</th><th>止码(L)</th>" +
            "<th>单价(元/L)</th><th>数量(L)</th><th>应收(元)</th><th>校验</th><th></th>" +
          "</tr></thead>" +
          "<tbody>" + rows + "</tbody>" +
        "</table></div>" +
        '<div id="group-totals" class="group-totals"></div>' +
      "</section>" +

      // 收款与长短款
      '<section class="panel">' +
        '<h3 class="block-title">收款汇总与长短款</h3>' +
        '<div class="summary-grid">' +
          '<label class="pay"><span>现金收入（元）</span>' +
            '<input data-field="cashYuan" value="' + esc(s.cashYuan) + '" placeholder="0.00" inputmode="decimal"></label>' +
          '<label class="pay"><span>电子支付（元）</span>' +
            '<input data-field="digitalYuan" value="' + esc(s.digitalYuan) + '" placeholder="0.00" inputmode="decimal"></label>' +
          '<div class="total-box"><span>应收合计</span><strong id="t-receivable">—</strong></div>' +
          '<div class="total-box"><span>实收合计</span><strong id="t-paid">—</strong></div>' +
          '<div class="total-box"><span>长短款</span><strong id="t-variance">—</strong></div>' +
        "</div>" +
        '<div id="variance-hint"></div>' +
        '<label class="reason-box"><span>长短款原因（差异为 0 时可不填；有长短款必须写明原因才能送复核）</span>' +
          '<textarea data-field="varianceReason" rows="2" placeholder="例：16:40 货车电子支付少扫46.40元，司机离场，已登记车牌并报值班经理">' +
          esc(s.varianceReason) + "</textarea></label>" +
      "</section>" +

      // 实时校验清单
      '<section class="panel"><div id="validate-box"></div></section>'
    );
  }

  /* ---------------- 只读凭证/待复核详情 ---------------- */

  function renderReadonly(s) {
    var ev = R.evaluateShift(s);
    var pay = R.summarizePayments(s, ev);

    var rows = ev.rows.map(function (r, i) {
      return (
        "<tr>" +
          '<td class="idx">' + (i + 1) + "</td>" +
          "<td>" + esc(r.seg.fuel) + "</td>" +
          "<td>" + esc(r.seg.pump) + "</td>" +
          '<td class="num">' + R.formatMeter(r.ev.start) + "</td>" +
          '<td class="num">' + R.formatMeter(r.ev.end) + "</td>" +
          '<td class="num">' + esc(r.seg.priceYuan || "—") + "</td>" +
          '<td class="num">' + r.ev.volume.toFixed(2) + "</td>" +
          '<td class="num">' + (r.ev.amountCents === null ? "—" : R.formatMoney(r.ev.amountCents)) + "</td>" +
          '<td class="seg-status-read">' +
            (r.ev.gap ? '<span class="tag tag-danger">泵码接不上</span>'
              : r.ev.issues.length ? '<span class="tag tag-danger">' + esc(r.ev.issues[0]) + "</span>"
              : '<span class="tag tag-ok">接续正常</span>') +
          "</td>" +
        "</tr>"
      );
    }).join("");

    var varianceCls = pay.varianceCents === null ? "" :
      pay.varianceCents === 0 ? "zero" : pay.varianceCents < 0 ? "short" : "over";

    return (
      '<section class="panel">' +
        '<h3 class="block-title">班次信息</h3>' +
        '<div class="meta-grid readonly">' +
          roField("班次日期", esc(s.date)) +
          roField("班次", esc(s.shiftType)) +
          roField("当班营业员", esc(s.attendant)) +
          roField("凭证编号", esc(s.code || "—")) +
        "</div>" +
      "</section>" +

      '<section class="panel">' +
        '<h3 class="block-title">价格段拆账</h3>' +
        '<div class="table-wrap"><table class="grid">' +
          "<thead><tr><th>#</th><th>油品</th><th>泵号</th><th>起始码</th><th>止码</th>" +
          "<th>单价</th><th>数量(L)</th><th>应收(元)</th><th>校验</th></tr></thead>" +
          "<tbody>" + rows + "</tbody>" +
        "</table></div>" +
        '<div class="group-totals">' + renderGroupTotalsHtml(ev) + "</div>" +
      "</section>" +

      '<section class="panel">' +
        '<h3 class="block-title">收款与长短款</h3>' +
        '<div class="summary-grid readonly">' +
          roBox("现金收入", pay.cashCents === null ? "—" : "¥" + R.formatMoney(pay.cashCents)) +
          roBox("电子支付", pay.digitalCents === null ? "—" : "¥" + R.formatMoney(pay.digitalCents)) +
          roBox("应收合计", ev.totalReceivableCents === null ? "待修正" : "¥" + R.formatMoney(ev.totalReceivableCents)) +
          roBox("实收合计", pay.paidCents === null ? "—" : "¥" + R.formatMoney(pay.paidCents)) +
          '<div class="total-box"><span>长短款</span><strong class="' + varianceCls + '">' +
            (pay.varianceCents === null ? "—" : (pay.varianceCents === 0 ? "账实一致" :
              R.formatSigned(pay.varianceCents) + " 元")) + "</strong></div>" +
        "</div>" +
        (s.varianceReason
          ? '<div class="reason-read">长短款原因：' + esc(s.varianceReason) + "</div>"
          : '<div class="reason-read muted">无长短款，无需填写原因。</div>') +
      "</section>"
    );
  }

  function roField(label, value) {
    return '<div class="ro-field"><span>' + label + '</span><b>' + value + "</b></div>";
  }

  function roBox(label, value) {
    return '<div class="total-box"><span>' + label + '</span><strong>' + value + "</strong></div>";
  }

  /* ---------------- 分组小计 ---------------- */

  function renderGroupTotalsHtml(ev) {
    if (!ev.groups.length) return "";
    return ev.groups.map(function (g) {
      var stateCls = g.hasGap ? "grp-danger" : g.hasIssue ? "grp-warn" : "grp-ok";
      return '<div class="grp ' + stateCls + '">' +
        "<b>" + esc(g.label) + "</b>" +
        "<span>" + g.volume.toFixed(2) + " L</span>" +
        "<span>应收 ¥" + R.formatMoney(g.amountCents) + "</span>" +
        (g.counted < g.total ? "<span class=\"muted\">" + g.counted + "/" + g.total + " 段可计价</span>" : "") +
        (g.hasGap ? '<span class="tag tag-danger">有待修正段</span>' : "") +
      "</div>";
    }).join("");
  }

  /* ---------------- 订正历史 ---------------- */

  function renderCorrections(s) {
    if (!s.corrections || !s.corrections.length) {
      if (s.status === R.STATUS.FROZEN) {
        return '<section class="panel"><h3 class="block-title">订正记录</h3>' +
          '<div class="muted">暂无订正，冻结凭证未被修改过。</div></section>';
      }
      return "";
    }
    var items = s.corrections.map(function (c, i) {
      var b = c.before;
      var a = c.after;
      var diffRows = [
        diffRow("现金收入", b.cashCents, a ? a.cashCents : null, true),
        diffRow("电子支付", b.digitalCents, a ? a.digitalCents : null, true),
        diffRow("应收合计", b.totalReceivableCents, a ? a.totalReceivableCents : null, true),
        diffRow("长短款", b.varianceCents, a ? a.varianceCents : null, true, true)
      ].join("");

      return (
        '<div class="correction">' +
          '<div class="correction-head">' +
            "<b>第 " + (i + 1) + " 次订正</b>" +
            '<span class="muted">发起：' + R.formatTime(c.at) + " · " + esc(c.actor) + "</span>" +
            (c.approvedAt
              ? '<span class="tag tag-ok">已通过 ' + R.formatTime(c.approvedAt) + " · " + esc(c.approver || "") + "</span>"
              : '<span class="tag tag-warn">待复核</span>') +
          "</div>" +
          '<div class="reason-read">订正原因：' + esc(c.reason) + "</div>" +
          '<div class="table-wrap"><table class="diff">' +
            "<thead><tr><th>项目</th><th>旧金额（订正前）</th><th>新金额（订正后）</th><th>差额</th></tr></thead>" +
            "<tbody>" + diffRows + "</tbody>" +
          "</table></div>" +
          '<div class="muted small">旧金额取自 ' + R.formatTime(b.at) + " 的冻结快照；价格段明细的旧值一并保留在该快照中。</div>" +
        "</div>"
      );
    }).join("");

    return '<section class="panel"><h3 class="block-title">订正记录（旧金额与时间留痕）</h3>' + items + "</section>";
  }

  function diffRow(label, oldCents, newCents, isMoney, signed) {
    var fmt = function (v) {
      if (v === null || v === undefined) return "待复核…";
      return isMoney ? "¥" + (signed ? R.formatSigned(v) : R.formatMoney(v)) : esc(v);
    };
    var delta = (oldCents != null && newCents != null) ? newCents - oldCents : null;
    var deltaCls = delta === null ? "" : delta === 0 ? "zero" : delta < 0 ? "short" : "over";
    return "<tr><td>" + label + "</td><td>" + fmt(oldCents) + "</td><td>" + fmt(newCents) +
      '</td><td class="' + deltaCls + '">' +
      (delta === null ? "—" : (delta === 0 ? "无变化" : R.formatSigned(delta) + " 元")) +
      "</td></tr>";
  }

  /* ---------------- 操作日志 ---------------- */

  function renderLogs(s) {
    var logs = (s.logs || []).map(function (l) {
      return "<li><span class=\"log-time\">" + R.formatTime(l.at) + "</span>" +
        "<span>" + esc(l.action) + (l.detail ? "（" + esc(l.detail) + "）" : "") + "</span>" +
        '<span class="muted">' + esc(l.actor) + "</span></li>";
    }).join("");
    return '<section class="panel"><h3 class="block-title">操作留痕</h3>' +
      '<ul class="logs">' + (logs || "<li>暂无</li>") + "</ul></section>";
  }

  /* ---------------- 底部操作区 ---------------- */

  function renderActions(s, editable) {
    var btns = "";
    var commentBox = "";
    var reasonBox = "";

    if (state.role === "manager") {
      if (s.status === R.STATUS.PENDING_REVIEW) {
        commentBox = reviewCommentBox("通过请核对：各价格段泵码接续、长短款原因。可填复核意见。");
        btns =
          '<button type="button" class="btn success" data-action="approve">复核通过 · 冻结成凭证</button>' +
          '<button type="button" class="btn danger" data-action="reject">退回修正</button>';
      } else if (s.status === R.STATUS.PENDING_CORRECTION) {
        commentBox = reviewCommentBox("订正复核：请对照订正记录中的旧金额/旧时间核对。");
        btns =
          '<button type="button" class="btn success" data-action="approve-correction">订正通过 · 重新冻结</button>' +
          '<button type="button" class="btn danger" data-action="reject">订正退回</button>';
      } else {
        btns = '<button type="button" class="btn" data-action="print">打印凭证</button>' +
          '<span class="hint">站长身份仅可查看，不能修改冻结凭证。</span>';
      }
    } else if (editable) {
      if (s.status === R.STATUS.CORRECTING) {
        reasonBox = fixedReasonBox(s);
        btns =
          '<button type="button" class="btn primary" data-action="submit-correction">订正完成 · 送站长复核</button>' +
          '<button type="button" class="btn" data-action="cancel-correction">放弃订正 · 恢复冻结凭证</button>';
      } else {
        btns =
          '<button type="button" class="btn primary" data-action="submit">送站长复核</button>' +
          '<button type="button" class="btn danger" data-action="delete">' +
          (s.code ? "删除班次" : "丢弃草稿") + "</button>";
      }
    } else if (s.status === R.STATUS.PENDING_REVIEW || s.status === R.STATUS.PENDING_CORRECTION) {
      btns = '<button type="button" class="btn" data-action="withdraw">' +
        (s.status === R.STATUS.PENDING_CORRECTION ? "撤回订正" : "撤回复核") + "</button>";
    } else if (s.status === R.STATUS.FROZEN) {
      reasonBox = correctionReasonBox();
      btns = '<button type="button" class="btn" data-action="print">打印凭证</button>' +
        '<button type="button" class="btn warn" data-action="request-correction">发起订正（保留旧金额与时间）</button>';
    }

    return '<section class="panel action-panel">' +
      reasonBox + commentBox +
      '<div id="action-error"></div>' +
      '<div class="action-bar">' +
        '<button type="button" class="btn" data-action="back">返回列表</button>' +
        btns +
      "</div></section>";
  }

  function reviewCommentBox(placeholder) {
    return '<label class="reason-box"><span>复核意见（退回时必须填写）</span>' +
      '<textarea data-field="reviewCommentInput" rows="2" placeholder="' + esc(placeholder) + '"></textarea></label>';
  }

  function correctionReasonBox() {
    return '<label class="reason-box"><span>订正原因（必填，将与旧金额、旧时间一起写入订正记录）</span>' +
      '<textarea data-field="correctionReason" rows="2" placeholder="例：监控核对确认泵码跳字异常，需更正92#第二段止码"></textarea></label>';
  }

  function fixedReasonBox(s) {
    var c = s.corrections[s.corrections.length - 1];
    return '<div class="banner banner-correcting">本次订正原因：' + esc(c ? c.reason : "") + "</div>";
  }

  /* ============================ 编辑页：派生刷新 ============================ */

  function currentEval() {
    var s = state.editing.shift;
    var ev = R.evaluateShift(s);
    var pay = R.summarizePayments(s, ev);
    return { ev: ev, pay: pay };
  }

  // 输入过程中只刷新派生区域（数量/应收/校验/合计/校验清单），不重建 <input>，避免焦点丢失
  function refreshDerived() {
    var ed = state.editing;
    if (!ed) return;
    var s = ed.shift;
    var d = currentEval();
    var ev = d.ev, pay = d.pay;

    // 逐段状态（限定在价格段表格内，避免与页面其他表格冲突）
    var segTable = document.querySelector("table.grid");
    ev.rows.forEach(function (r, i) {
      var tr = segTable && segTable.querySelector('tr[data-idx="' + i + '"]');
      if (!tr) return;
      var vol = tr.querySelector(".seg-volume");
      var amt = tr.querySelector(".seg-amount");
      var st = tr.querySelector(".seg-status");
      if (vol) vol.textContent = r.ev.empty ? "—" : r.ev.volume.toFixed(2);
      if (amt) {
        amt.textContent = r.ev.amountCents === null ? (r.ev.empty ? "—" : "待修正") : R.formatMoney(r.ev.amountCents);
        amt.className = "num seg-amount " + (r.ev.amountCents === null ? "bad" : "");
      }
      if (st) {
        if (r.ev.empty) {
          st.innerHTML = '<span class="tag">空白段</span>';
        } else if (r.ev.gap) {
          st.innerHTML = '<span class="tag tag-danger">待修正：泵码接不上</span>';
        } else if (r.ev.issues.length) {
          st.innerHTML = '<span class="tag tag-danger" title="' + esc(r.ev.issues.join("；")) + '">' +
            esc(r.ev.issues[0]) + "</span>";
        } else {
          st.innerHTML = '<span class="tag tag-ok">正常</span>';
        }
      }
    });

    // 待修正总提示
    var gapAlert = document.getElementById("gap-alert");
    if (gapAlert) {
      var gaps = ev.rows.filter(function (r) { return r.ev.gap; });
      gapAlert.innerHTML = gaps.length
        ? '<div class="banner banner-danger">⚠ 有 ' + gaps.length +
          ' 个价格段泵码接不上，已留在「待修正」，修正前不能送站长复核：' +
          gaps.map(function (r) {
            return esc(R.groupLabel(r.key));
          }).join("、") + "</div>"
        : "";
    }

    // 分组小计
    var gt = document.getElementById("group-totals");
    if (gt) gt.innerHTML = renderGroupTotalsHtml(ev);

    // 合计
    setText("t-receivable", ev.totalReceivableCents === null ? "待修正" : "¥" + R.formatMoney(ev.totalReceivableCents));
    setText("t-paid", pay.paidCents === null ? "—" : "¥" + R.formatMoney(pay.paidCents));
    var tv = document.getElementById("t-variance");
    if (tv) {
      if (pay.varianceCents === null) {
        tv.textContent = "—";
        tv.className = "";
      } else if (pay.varianceCents === 0) {
        tv.textContent = "账实一致";
        tv.className = "zero";
      } else {
        tv.textContent = R.formatSigned(pay.varianceCents) + " 元";
        tv.className = pay.varianceCents < 0 ? "short" : "over";
      }
    }

    // 长短款原因提示
    var vh = document.getElementById("variance-hint");
    if (vh) {
      if (pay.varianceCents !== null && pay.varianceCents !== 0) {
        vh.innerHTML = '<div class="banner banner-warn">当前为' +
          (pay.varianceCents < 0 ? "短款" : "长款") + " " + R.formatMoney(Math.abs(pay.varianceCents)) +
          " 元，必须在下方写明原因。</div>";
      } else {
        vh.innerHTML = "";
      }
    }

    // 送复核校验清单
    var vb = document.getElementById("validate-box");
    if (vb) {
      var errors = R.validateForSubmit(s, ev, pay);
      if (errors.length) {
        vb.innerHTML = '<div class="validate-err"><b>送复核前还需处理（' + errors.length + '）：</b><ul>' +
          errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>";
      } else {
        vb.innerHTML = '<div class="validate-ok">✓ 校验通过：价格段齐全、泵码接续、金额可汇总，可送站长复核。</div>';
      }
      var submitBtn = document.querySelector('[data-action="submit"], [data-action="submit-correction"]');
      if (submitBtn) submitBtn.classList.toggle("disabled-look", errors.length > 0);
    }
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /* ============================ 编辑页：事件绑定 ============================ */

  function bindEditor() {
    var ed = state.editing;
    if (!ed) {
      var back = document.querySelector("[data-action='back']");
      if (back) back.addEventListener("click", function () { go("#/list"); });
      return;
    }
    var s = ed.shift;
    var editable = ed.mode === "edit";

    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.addEventListener("click", onAction);
    });

    if (!editable) return;

    // 基础信息 / 支付 / 原因
    document.querySelectorAll("[data-field]").forEach(function (input) {
      var field = input.getAttribute("data-field");
      if (field === "reviewCommentInput" || field === "correctionReason") return;
      var evt = input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(evt, function () {
        s[field] = input.value;
        persistEditing();
        refreshDerived();
      });
    });

    // 表格内各段
    document.querySelectorAll("tr[data-idx]").forEach(function (tr) {
      var idx = Number(tr.getAttribute("data-idx"));
      tr.querySelectorAll("[data-field]").forEach(function (input) {
        var field = input.getAttribute("data-field");
        var evt = input.tagName === "SELECT" ? "change" : "input";
        input.addEventListener(evt, function () {
          s.segments[idx][field] = input.value;
          persistEditing();
          refreshDerived();
        });
      });
    });
  }

  function onAction(e) {
    var action = e.currentTarget.getAttribute("data-action");
    var ed = state.editing;
    var s = ed ? ed.shift : null;

    switch (action) {
      case "back":
        go("#/list");
        return;

      case "add-seg":
        s.segments.push({ id: R.uid(), fuel: "", pump: "", meterStart: "", meterEnd: "", priceYuan: "" });
        persistEditing();
        rerunEditorPreserve(s);
        return;

      case "del-seg": {
        var idx = Number(e.currentTarget.getAttribute("data-idx"));
        s.segments.splice(idx, 1);
        if (!s.segments.length) {
          s.segments.push({ id: R.uid(), fuel: "", pump: "", meterStart: "", meterEnd: "", priceYuan: "" });
        }
        persistEditing();
        rerunEditorPreserve(s);
        return;
      }

      case "submit":
        doSubmit(s);
        return;

      case "withdraw":
        R.withdraw(s, "营业员·" + (s.attendant || ""));
        S.upsertShift(s);
        toast("已撤回，可继续修正");
        rerenderExisting(s.id);
        return;

      case "approve":
        doApprove(s, false);
        return;

      case "approve-correction":
        doApprove(s, true);
        return;

      case "reject":
        doReject(s);
        return;

      case "request-correction":
        doRequestCorrection(s);
        return;

      case "submit-correction":
        doSubmitCorrection(s);
        return;

      case "cancel-correction":
        doCancelCorrection(s);
        return;

      case "delete":
        if (window.confirm("确定丢弃该班次草稿？丢弃后不可恢复。")) {
          if (ed.id === "new") S.clearDraft("new");
          else S.removeShift(s.id);
          toast("草稿已丢弃");
          go("#/list");
        }
        return;

      case "print":
        window.print();
        return;
    }
  }

  // 结构性改动（增删段）后整体重绘，并尽量把焦点交还给表格
  function rerunEditorPreserve(s) {
    var active = document.activeElement;
    var tag = active && (active.tagName === "INPUT" || active.tagName === "SELECT") ? active.tagName : null;
    render();
    if (tag) {
      var rows = document.querySelectorAll("tr[data-idx]");
      var last = rows[rows.length - 1];
      if (last) {
        var target = last.querySelector(tag === "SELECT" ? "select" : "input");
        if (target) target.focus();
      }
    }
  }

  function rerenderExisting(id) {
    go("#/shift/" + encodeURIComponent(id));
  }

  /* ---------------- 流程动作 ---------------- */

  function doSubmit(s) {
    var d = currentEval();
    var errors = R.validateForSubmit(s, d.ev, d.pay);
    if (errors.length) {
      showActionError(errors);
      toast("还有 " + errors.length + " 项未满足，不能送复核", false);
      return;
    }
    if (!s.code) s.code = S.nextVoucherCode(s.date);
    var actor = "营业员·" + (s.attendant || "");
    R.submit(s, actor);
    S.upsertShift(s);
    S.clearDraft("new");
    toast("已送站长复核，凭证编号 " + s.code);
    go("#/shift/" + encodeURIComponent(s.id));
  }

  function doSubmitCorrection(s) {
    var d = currentEval();
    var errors = R.validateForSubmit(s, d.ev, d.pay);
    if (errors.length) {
      showActionError(errors);
      toast("订正内容仍有未满足项", false);
      return;
    }
    R.submitCorrection(s, "营业员·" + (s.attendant || ""));
    S.upsertShift(s);
    toast("订正已送站长复核");
    rerenderExisting(s.id);
  }

  function doApprove(s, isCorrection) {
    var comment = (document.querySelector("[data-field='reviewCommentInput']") || {}).value || "";
    var actor = "站长·周强";
    if (isCorrection) {
      R.approveCorrection(s, actor, comment.trim());
    } else {
      R.approve(s, actor, comment.trim());
    }
    S.upsertShift(s);
    toast(isCorrection ? "订正通过，凭证已重新冻结" : "复核通过，整班已冻结为只读凭证");
    rerenderExisting(s.id);
  }

  function doReject(s) {
    var comment = ((document.querySelector("[data-field='reviewCommentInput']") || {}).value || "").trim();
    if (!comment) {
      showActionError(["退回时必须填写复核意见，说明需要修正什么。"]);
      toast("请先填写退回意见", false);
      return;
    }
    R.reject(s, "站长·周强", comment);
    S.upsertShift(s);
    toast("已退回营业员修正");
    rerenderExisting(s.id);
  }

  function doRequestCorrection(s) {
    var reason = ((document.querySelector("[data-field='correctionReason']") || {}).value || "").trim();
    if (reason.length < 5) {
      showActionError(["发起订正必须填写原因（至少 5 个字）。"]);
      toast("请填写订正原因", false);
      return;
    }
    R.requestCorrection(s, "营业员·" + (s.attendant || ""), reason);
    S.upsertShift(s);
    toast("已进入订正，冻结凭证作为旧值保留");
    rerenderExisting(s.id);
  }

  function doCancelCorrection(s) {
    if (!window.confirm("放弃本次订正？所有修改将丢弃，凭证恢复为冻结时的只读内容。")) return;
    var snap = s.frozenSnapshot;
    // 丢弃最后一条未通过的订正
    s.corrections.pop();
    if (snap) {
      restoreFromSnapshot(s, snap);
    }
    s.status = R.STATUS.FROZEN;
    R.addLog(s, "放弃订正，恢复冻结凭证", "营业员·" + (s.attendant || ""), "");
    S.upsertShift(s);
    toast("已恢复为冻结凭证");
    rerenderExisting(s.id);
  }

  // 用冻结快照把可编辑字段还原（日志/编号/状态等外层字段保留）
  function restoreFromSnapshot(s, snap) {
    s.date = snap.date;
    s.shiftType = snap.shiftType;
    s.attendant = snap.attendant;
    s.cashYuan = snap.cashCents === null ? "" : R.centsToYuan(snap.cashCents);
    s.digitalYuan = snap.digitalCents === null ? "" : R.centsToYuan(snap.digitalCents);
    s.varianceReason = snap.varianceReason || "";
    s.segments = snap.segments.map(function (g) {
      return {
        id: R.uid(),
        fuel: g.fuel,
        pump: g.pump,
        meterStart: g.meterStart,
        meterEnd: g.meterEnd,
        priceYuan: g.priceYuan
      };
    });
  }

  function showActionError(errors) {
    var box = document.getElementById("action-error");
    if (box) {
      box.innerHTML = '<div class="banner banner-danger"><b>无法提交：</b><ul class="action-errors">' +
        errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>";
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /* ================================ 角色切换 ================================ */

  function syncRoleButtons() {
    document.querySelectorAll(".role-btn").forEach(function (btn) {
      btn.classList.toggle("on", btn.getAttribute("data-role") === state.role);
      btn.setAttribute("aria-pressed", btn.getAttribute("data-role") === state.role ? "true" : "false");
    });
  }

  document.querySelectorAll(".role-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var role = btn.getAttribute("data-role");
      if (role === state.role) return;
      state.role = role;
      S.setRole(role);
      state.editing = null;
      go("#/list");
      toast(role === "manager" ? "已切换为站长：可复核，页面只读" : "已切换为营业员：可录入与订正");
    });
  });

  /* ================================ 启动 ================================ */

  if (!location.hash) location.hash = "#/list";
  render();
})();
