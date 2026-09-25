import http from "node:http";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonStore } from "./src/store/json-store.js";
import {
  UNITS,
  ERROR_STATUS,
  LedgerError,
  normalizeSample,
  findSample,
  registerRemainder,
  correctRemainder,
  addSplit,
  shipSplit,
  submitReceipt
} from "./src/domain/ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ? process.env.DB_PATH : join(__dirname, "data", "core-slices.json");
const store = createJsonStore(dbPath);
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
const nowIso = () => new Date().toISOString();

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      remainder: { total: 0.6, unit: "m", note: "余芯段，箱内第 3 排", registeredAt: "2026-09-01T08:00:00.000Z" },
      correctionHistory: [],
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ],
      splits: [
        {
          uid: "SP-seed-001-1",
          id: "FY-001-1",
          interval: { from: 128.4, to: 128.55 },
          depth: "128.4-128.55m",
          quantity: 0.15,
          unit: "m",
          purpose: "外送：铜品位、硫含量分析",
          status: "已外送",
          frozen: true,
          shippedAt: "2026-09-10T03:00:00.000Z",
          receipt: {
            items: ["铜品位", "硫含量"],
            conclusion: "Cu 1.42%，矿化连续，建议加深控制",
            testedAt: "2026-09-14",
            receivedAt: "2026-09-15T06:30:00.000Z",
            archived: true,
            archivedAt: "2026-09-15T06:30:00.000Z"
          },
          conclusion: "Cu 1.42%，矿化连续，建议加深控制",
          lateReceipts: [],
          conflicts: [],
          conflictHistory: [{ at: "2026-09-02T08:00:00.000Z", reason: "分样登记核验", from: [], to: [] }],
          conflictNote: "登记时核验通过",
          needsAttention: false,
          affectedByCorrection: false,
          createdAt: "2026-09-02T08:00:00.000Z"
        },
        {
          uid: "SP-seed-001-2",
          id: "FY-001-2",
          interval: { from: 128.5, to: 128.7 },
          depth: "128.5-128.7m",
          quantity: 0.6,
          unit: "m",
          purpose: "内部薄片鉴定",
          status: "未外送",
          frozen: false,
          shippedAt: null,
          receipt: null,
          conclusion: "",
          lateReceipts: [],
          conflicts: ["interval_overlap", "exceeds_remainder"],
          conflictHistory: [
            { at: "2026-09-03T08:00:00.000Z", reason: "分样登记核验", from: [], to: ["interval_overlap", "exceeds_remainder"] }
          ],
          conflictNote: "登记时检出冲突：区间重叠、超出余料；原记录已保留",
          needsAttention: true,
          affectedByCorrection: false,
          createdAt: "2026-09-03T08:00:00.000Z"
        }
      ]
    },
    {
      id: "CORE-002",
      project: "北坡金矿化探",
      borehole: "ZK-03",
      coreBox: "BX-02",
      depth: "45.1-46.0m",
      owner: "沈舟",
      status: "待切割",
      delivery: "未交付",
      remainder: null,
      correctionHistory: [],
      slices: [],
      splits: []
    }
  ]
};

async function loadDb() {
  await store.ensure(seed);
  const db = await store.load();
  if (!Array.isArray(db.samples)) db.samples = [];
  db.samples.forEach(normalizeSample); // 旧数据补台账字段（幂等）
  return db;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LedgerError("invalid_json", "请求体不是合法 JSON");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, error) {
  if (error instanceof LedgerError) {
    return sendJson(res, ERROR_STATUS[error.code] || 400, { error: error.code, message: error.message });
  }
  sendJson(res, 500, { error: "internal_error", message: error.message });
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map((slice) => slice.status);
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.length && sliceStatuses.every((step) => step === "观察")) sample.status = "待观察";
  else if (sliceStatuses.some((step) => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯分样与外送台账</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#b3402f; --warnbg:#fbecea; --ship:#2f5d8a; --shipbg:#eef3f8; --aff:#9a6b12; --affbg:#fdf4e2; --ok:#3f7a4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    h3 { margin:0 0 8px; font-size:18px; } h4 { margin:12px 0 8px; font-size:14px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:56px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .ledger { border-top:1px dashed var(--line); padding-top:6px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; margin:6px 0; align-items:center; } .row > * { flex:1 1 110px; } .row button { flex:0 0 auto; white-space:nowrap; }
    .split-row { border:1px solid var(--line); border-radius:8px; padding:10px; margin:8px 0; display:grid; gap:6px; background:#fafbf9; }
    .split-row.frozen { border-color:#c3d2e0; background:var(--shipbg); }
    .split-row.conflict { border-color:#e0b8b0; background:var(--warnbg); }
    .sp-head { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .badge { border-radius:999px; padding:2px 8px; font-size:12px; font-weight:700; }
    .b-warn { background:var(--warnbg); color:var(--warn); border:1px solid var(--warn); }
    .b-ship { background:var(--shipbg); color:var(--ship); border:1px solid var(--ship); }
    .b-aff { background:var(--affbg); color:var(--aff); border:1px solid var(--aff); }
    .neg { color:var(--warn); } .ok { color:var(--ok); }
    .receipt { border:1px solid var(--line); border-radius:6px; padding:8px; background:#fff; }
    .receipt.archived { border-color:var(--ok); background:#f2f8f3; }
    .late { border-left:3px solid var(--aff); padding:4px 8px; background:#fff; border-radius:4px; margin-top:6px; }
    .hist { margin:6px 0 0; padding-left:18px; font-size:12px; color:var(--muted); }
    .slice { border-top:1px solid var(--line); padding-top:8px; margin-top:8px; }
    #toast { position:fixed; top:16px; left:50%; transform:translateX(-50%); padding:10px 18px; border-radius:8px; background:#242822; color:#fff; font-size:14px; display:none; z-index:10; max-width:80vw; }
    #toast.err { background:var(--warn); }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:repeat(2,1fr);} }
  </style>
</head>
<body>
  <header><div><h1>岩芯分样与外送台账</h1><div class="meta">母样余料登记 · 分样深度/数量/用途 · 冲突留痕 · 外送冻结 · 回执归档 · 更正重算</div></div><button id="reload">刷新</button></header>
  <div id="toast"></div>
  <main>
    <form id="form">
      <h2>创建岩芯母样</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" placeholder="如 128.4-128.8m" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存母样</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const UNITS = ${JSON.stringify(UNITS)};
    const statuses = ${JSON.stringify(statuses)};
    const STEPS = ${JSON.stringify(taskSteps)};
    const CONFLICT_LABEL = { interval_overlap:"区间重叠", exceeds_remainder:"超出余料", duplicate_id:"编号重复" };
    const form = document.querySelector("#form");
    const statsEl = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const toastEl = document.querySelector("#toast");
    let samples = [];
    let toastTimer = null;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    const fmt = (iso) => iso ? String(iso).slice(0, 16).replace("T", " ") : "";
    function toast(message, ok = true) {
      toastEl.textContent = message;
      toastEl.className = ok ? "" : "err";
      toastEl.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, 3600);
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    const post = (path, payload) => api(path, { method: "POST", body: JSON.stringify(payload) });

    function remainderView(s) {
      if (!s.remainder) {
        return '<div class="meta">尚未登记余料，分样前请先登记。</div>'
          + '<div class="row"><input data-f="reg-total" type="number" step="any" placeholder="余料数量"><select data-f="reg-unit">'
          + UNITS.map((u) => '<option>' + u + '</option>').join("") + '</select></div>'
          + '<input data-f="reg-note" placeholder="余料说明（可选）">'
          + '<div class="row"><button data-act="register-remainder">登记余料</button></div>';
      }
      const used = s.splits.reduce((a, x) => a + x.quantity, 0);
      const avail = s.remainder.total - used;
      const history = s.correctionHistory.length ? '<ol class="hist">' + s.correctionHistory.map((c) =>
        '<li>' + fmt(c.at) + ' ' + esc(c.reason) + '：' + c.from.total + esc(c.from.unit) + ' → ' + c.to.total + esc(c.to.unit)
        + '；未外送重算 [' + esc(c.recomputed.join("、") || "无") + ']'
        + '；已外送受影响 [' + esc(c.affectedShipped.join("、") || "无") + ']</li>').join("") + '</ol>' : "";
      return '<div class="rline">余料 <b>' + s.remainder.total + esc(s.remainder.unit) + '</b> · 已分 ' + used
        + ' · 可用 <b class="' + (avail < 0 ? "neg" : "ok") + '">' + avail + '</b>'
        + (s.remainder.note ? ' · ' + esc(s.remainder.note) : "")
        + ' <span class="meta">登记于 ' + fmt(s.remainder.registeredAt) + '</span></div>'
        + '<div class="row"><input data-f="cor-total" type="number" step="any" value="' + s.remainder.total + '">'
        + '<input data-f="cor-reason" placeholder="更正原因（必填）"><button data-act="correct-remainder">余料更正（未外送重算）</button></div>' + history;
    }

    function receiptView(sp) {
      const form = '<div class="receipt"><div class="row"><input data-f="rc-items" placeholder="检测项目（逗号分隔，如 铜品位,硫含量）"></div>'
        + '<textarea data-f="rc-conclusion" placeholder="检测结论"></textarea>'
        + '<div class="row"><input data-f="rc-tested" type="date"><button data-act="receipt">'
        + (sp.receipt && sp.receipt.archived ? "补交迟到回执（不覆盖已归档结论）" : "登记回执并归档") + '</button></div></div>';
      let html = "";
      if (sp.receipt && sp.receipt.archived) {
        html += '<div class="receipt archived"><b>已归档回执（结论不可更改）</b>'
          + '<div class="meta">检测项目：' + esc(sp.receipt.items.join("、")) + '</div>'
          + '<div>结论：' + esc(sp.receipt.conclusion) + '</div>'
          + '<div class="meta">检测日期 ' + esc(sp.receipt.testedAt || "—") + ' · 回执到达 ' + fmt(sp.receipt.receivedAt) + ' · 归档于 ' + fmt(sp.receipt.archivedAt) + '</div></div>';
      } else {
        html += '<div class="meta">外送已冻结，等待首份回执。</div>';
      }
      html += form;
      if (sp.lateReceipts && sp.lateReceipts.length) {
        html += sp.lateReceipts.map((r) => '<div class="late"><b>迟到回执</b> <span class="meta">' + fmt(r.receivedAt) + '</span>'
          + '<div class="meta">检测项目：' + esc(r.items.join("、")) + ' · 检测日期 ' + esc(r.testedAt || "—") + '</div>'
          + '<div>结论：' + esc(r.conclusion) + '</div><div class="meta">' + esc(r.note) + '</div></div>').join("");
      }
      return html;
    }

    function splitRow(s, sp) {
      const badges = sp.conflicts.map((c) => '<span class="badge b-warn">' + (CONFLICT_LABEL[c] || esc(c)) + '</span>').join("");
      let affected = "";
      if (sp.affectedByCorrection && sp.affectedInfo) {
        affected = '<span class="badge b-aff">受余料更正影响 · 旧档保留</span>'
          + '<div class="meta">更正 ' + fmt(sp.affectedInfo.at) + '（' + esc(sp.affectedInfo.reason) + '）：旧档冲突 ['
          + esc((sp.affectedInfo.archivedConflicts || []).map((c) => CONFLICT_LABEL[c] || c).join("、") || "无")
          + ']，按当前余料应为 ['
          + esc((sp.affectedInfo.currentConflicts || []).map((c) => CONFLICT_LABEL[c] || c).join("、") || "无") + ']</div>';
      }
      const body = sp.frozen
        ? '<div class="meta">外送时间：' + fmt(sp.shippedAt) + ' · 分样已冻结</div>' + receiptView(sp)
        : '<div class="row"><button data-act="ship">登记外送（外送后冻结）</button></div>';
      const history = sp.conflictHistory && sp.conflictHistory.length
        ? '<details class="meta"><summary>核验记录（' + sp.conflictHistory.length + '）</summary><ol class="hist">'
          + sp.conflictHistory.map((h) => '<li>' + fmt(h.at) + ' ' + esc(h.reason) + '：['
            + esc((h.from || []).map((c) => CONFLICT_LABEL[c] || c).join("、") || "无") + '] → ['
            + esc((h.to || []).map((c) => CONFLICT_LABEL[c] || c).join("、") || "无") + ']</li>').join("") + '</ol></details>'
        : "";
      return '<div class="split-row ' + (sp.frozen ? "frozen " : "") + (sp.conflicts.length ? "conflict" : "") + '" data-row="' + esc(s.id) + '|' + esc(sp.uid) + '">'
        + '<div class="sp-head"><b>' + esc(sp.id) + '</b><span class="badge ' + (sp.frozen ? "b-ship" : "") + '">' + esc(sp.status) + '</span>'
        + badges + (sp.needsAttention ? '<span class="badge b-warn">待处理</span>' : "") + affected + '</div>'
        + '<div class="meta">深度 ' + sp.interval.from + '–' + sp.interval.to + ' m · 数量 ' + sp.quantity + esc(sp.unit) + ' · 用途：' + esc(sp.purpose) + '</div>'
        + '<div class="meta">核验：' + esc(sp.conflictNote || "—") + '</div>'
        + body + history + '</div>';
    }

    function addSplitForm(s) {
      if (!s.remainder) return '<div class="meta">登记母样余料后即可分样。</div>';
      return '<div class="row"><input data-f="sp-id" placeholder="分样编号"><input data-f="sp-from" type="number" step="any" placeholder="深度自(m)">'
        + '<input data-f="sp-to" type="number" step="any" placeholder="深度至(m)"></div>'
        + '<div class="row"><input data-f="sp-qty" type="number" step="any" placeholder="数量（' + esc(s.remainder.unit) + '）">'
        + '<input data-f="sp-purpose" placeholder="用途（如：外送铜品位分析）"><button data-act="add-split">登记分样</button></div>'
        + '<div class="meta">单位随母样（' + esc(s.remainder.unit) + '）。区间重叠 / 超出余料 / 编号重复时，记录仍保留并标注冲突，不覆盖旧记录。</div>';
    }

    function slicesView(s) {
      const rows = s.slices.map((sl) =>
        '<div class="slice"><b>' + esc(sl.id) + '</b><div class="meta">' + esc(sl.method) + ' · 当前步骤 ' + esc(sl.status) + '</div>'
        + '<select data-f="sl-step">' + STEPS.map((step) => '<option>' + step + '</option>').join("") + '</select>'
        + '<textarea data-f="sl-note" placeholder="步骤备注或观察结果"></textarea>'
        + '<div class="row"><button data-act="log-slice" data-fid="' + esc(sl.id) + '">记录步骤</button></div>'
        + '<div class="meta">' + sl.logs.map((l) => esc(l.step) + "：" + esc(l.note)).join(" / ") + '</div></div>').join("");
      const add = '<div class="row"><input data-f="sl-id" placeholder="新切片编号"><input data-f="sl-method" placeholder="染色方法">'
        + '<button data-act="add-slice">添加切片</button></div>';
      return rows + add;
    }

    function render() {
      const allSplits = samples.flatMap((s) => s.splits);
      const statRows = [
        ["母样", samples.length],
        ["分样", allSplits.length],
        ["含冲突分样", allSplits.filter((x) => x.conflicts.length).length],
        ["已外送冻结", allSplits.filter((x) => x.status === "已外送").length],
        ["已归档回执", allSplits.filter((x) => x.receipt && x.receipt.archived).length]
      ];
      statsEl.innerHTML = statRows.map(([label, n]) => '<div class="stat"><span>' + label + '</span><strong>' + n + '</strong></div>').join("");
      samplesEl.innerHTML = samples.map((s) =>
        '<article class="card" data-card="' + esc(s.id) + '"><h3>' + esc(s.project) + ' <span class="meta">' + esc(s.id) + '</span></h3>'
        + '<div><span class="pill">' + esc(s.status) + '</span> <span class="pill">' + esc(s.delivery) + '</span></div>'
        + '<div class="meta">' + esc(s.borehole) + ' · ' + esc(s.coreBox) + ' · 母样段 ' + esc(s.depth) + ' · ' + esc(s.owner) + '</div>'
        + '<div class="ledger"><h4>① 母样余料</h4>' + remainderView(s) + '</div>'
        + '<div class="ledger"><h4>② 分样与外送台账</h4>' + s.splits.map((sp) => splitRow(s, sp)).join("") + addSplitForm(s) + '</div>'
        + '<div class="ledger"><h4>③ 制片切片（原流程）</h4>' + slicesView(s) + '</div>'
        + '<div class="row"><button data-act="deliver">标记母样交付</button></div></article>').join("");

      document.querySelectorAll("[data-card]").forEach((card) => {
        const s = samples.find((x) => x.id === card.dataset.card);
        card.querySelectorAll(".slice").forEach((box, i) => {
          const sl = s.slices[i];
          if (sl) box.querySelector("[data-f='sl-step']").value = sl.status;
        });
      });
    }

    async function load() { samples = await api("/api/samples"); render(); }

    samplesEl.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-act]");
      if (!btn) return;
      const card = btn.closest("[data-card]");
      const sid = card.dataset.card;
      const val = (name) => { const el = card.querySelector('[data-f="' + name + '"]'); return el ? el.value.trim() : ""; };
      const rowId = () => { const row = btn.closest("[data-row]"); return row ? row.dataset.row.split("|")[1] : null; };
      try {
        switch (btn.dataset.act) {
          case "register-remainder":
            await post("/api/samples/" + sid + "/remainder", { total: val("reg-total"), unit: val("reg-unit"), note: val("reg-note") });
            toast("母样余料已登记"); break;
          case "correct-remainder": {
            const d = await post("/api/samples/" + sid + "/correct-remainder", { total: val("cor-total"), reason: val("cor-reason") });
            toast("余料已更正：未外送重算 " + d.recomputed.length + " 个，已外送受影响 " + d.affectedShipped.length + " 个（旧档保留）");
            break;
          }
          case "add-split":
            await post("/api/samples/" + sid + "/splits", {
              id: val("sp-id"), depthFrom: val("sp-from"), depthTo: val("sp-to"),
              quantity: val("sp-qty"), purpose: val("sp-purpose")
            });
            toast("分样已登记（如检出冲突，已在记录中标注）"); break;
          case "ship":
            await post("/api/samples/" + sid + "/splits/" + encodeURIComponent(rowId()) + "/ship", {});
            toast("分样已外送并冻结"); break;
          case "receipt": {
            const d = await post("/api/samples/" + sid + "/splits/" + encodeURIComponent(rowId()) + "/receipt", {
              items: val("rc-items"), conclusion: val("rc-conclusion"), testedAt: val("rc-tested")
            });
            toast(d.archived ? "回执已登记，项目与结论已归档" : "迟到回执已附注留存，已归档结论未改动");
            break;
          }
          case "add-slice":
            await api("/api/samples/" + sid + "/slices", { method: "POST", body: JSON.stringify({ id: val("sl-id"), method: val("sl-method") || "未指定" }) });
            toast("切片已添加"); break;
          case "log-slice": {
            const box = btn.closest(".slice");
            await api("/api/samples/" + sid + "/slices/" + encodeURIComponent(btn.dataset.fid) + "/logs", {
              method: "POST", body: JSON.stringify({ step: box.querySelector('[data-f="sl-step"]').value, note: val("sl-note") || "步骤完成" })
            });
            toast("步骤已记录"); break;
          }
          case "deliver":
            await api("/api/samples/" + sid + "/deliver", { method: "POST", body: JSON.stringify({}) });
            toast("母样已标记交付"); break;
        }
        await load();
      } catch (err) {
        toast(err.message, false);
      }
    });

    document.querySelector("#reload").onclick = load;
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/samples", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); toast("母样已创建"); await load();
      } catch (err) { toast(err.message, false); }
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/samples") {
      const db = await loadDb();
      return sendJson(res, 200, db.samples);
    }

    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const db = await loadDb();
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project, borehole: input.borehole, coreBox: input.coreBox,
        depth: input.depth, owner: input.owner,
        status: "待切割", delivery: "未交付",
        remainder: null, splits: [], correctionHistory: [],
        slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: nowIso(), step: "取样", note: "创建初始切片任务" }] }]
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await store.save(db);
      return sendJson(res, 201, sample);
    }

    let m = url.pathname.match(/^\/api\/samples\/([^/]+)\/remainder$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      registerRemainder(sample, await body(req), nowIso());
      await store.save(db);
      return sendJson(res, 200, sample);
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/correct-remainder$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      const { correction } = correctRemainder(sample, await body(req), nowIso());
      await store.save(db);
      return sendJson(res, 200, {
        sample,
        recomputed: correction.recomputed,
        affectedShipped: correction.affectedShipped
      });
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/splits$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      const split = addSplit(sample, await body(req), nowIso(), db.samples);
      await store.save(db);
      return sendJson(res, 201, { sample, split });
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/splits\/([^/]+)\/ship$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      shipSplit(sample, decodeURIComponent(m[2]), nowIso());
      await store.save(db);
      return sendJson(res, 200, sample);
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/splits\/([^/]+)\/receipt$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      const { split, archived } = submitReceipt(sample, decodeURIComponent(m[2]), await body(req), nowIso());
      await store.save(db);
      return sendJson(res, 200, { sample, split, archived });
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: nowIso(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await store.save(db);
      return sendJson(res, 201, sample);
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      const slice = sample.slices.find((item) => item.id === decodeURIComponent(m[2]));
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: nowIso(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await store.save(db);
      return sendJson(res, 200, sample);
    }

    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (m && req.method === "POST") {
      const db = await loadDb();
      const sample = findSample(db.samples, decodeURIComponent(m[1]));
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await store.save(db);
      return sendJson(res, 200, sample);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, () => console.log(`Core split ledger app listening on http://localhost:${port}`));
