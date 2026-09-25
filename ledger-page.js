export const ledgerPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>分样与外送台账</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#9a6a12; --bad:#9c3a2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:17px; } h3 { margin:0; font-size:16px; }
    main { padding:22px 28px; display:grid; gap:16px; }
    a { color:var(--accent); }
    .panel,.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    .card { display:grid; gap:12px; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.frozen { background:#eef1ea; } .pill.conflict { border-color:var(--warn); color:var(--warn); } .pill.affected { border-color:var(--bad); color:var(--bad); }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; } th { color:var(--muted); font-weight:600; white-space:nowrap; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .row { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; align-items:end; }
    label { display:block; margin:0 0 4px; color:var(--muted); font-size:12px; }
    .split { border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:8px; }
    .split.frozen { background:#fafbf8; }
    .conflict-line { color:var(--warn); font-size:12px; } .affected-note { color:var(--bad); font-size:12px; }
    .archived { border-left:3px solid var(--accent); padding-left:10px; }
    .late { color:var(--muted); font-size:12px; border-left:3px solid var(--line); padding-left:10px; }
    .msg { position:fixed; right:20px; bottom:20px; max-width:380px; display:grid; gap:8px; }
    .msg div { background:var(--ink); color:#fff; padding:10px 14px; border-radius:8px; font-size:13px; }
    .msg div.err { background:var(--bad); }
  </style>
</head>
<body>
  <header>
    <div><h1>分样与外送台账</h1><div class="meta">母样余料 · 分样深度/数量/用途 · 外送冻结 · 回执归档</div></div>
    <div><a href="/">← 切片实验室</a> <button id="reload" style="margin-left:12px">刷新</button></div>
  </header>
  <main>
    <section class="panel">
      <h2>母样</h2>
      <div id="samples"></div>
    </section>
  </main>
  <div class="msg" id="msg"></div>

  <script>
    const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    let samples = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function toast(text, isErr) {
      const box = document.querySelector("#msg");
      const el = document.createElement("div");
      if (isErr) el.className = "err";
      el.textContent = text;
      box.appendChild(el);
      setTimeout(() => el.remove(), 4500);
    }
    function conflictPills(sp) {
      return sp.conflicts.map(c => '<span class="pill conflict">'+esc(c.type)+'</span>').join(" ");
    }
    function renderSplit(sample, sp) {
      const frozenNote = sp.frozen ? '<span class="pill frozen">已外送冻结</span>' : '<span class="pill">在库</span>';
      const affected = sp.affected ? '<div class="affected-note">⚠ 母样余料已更正，本外送分样保留旧档，结论可能受影响（余料快照 '+esc(sp.remainderSnapshot?.quantity)+esc(sp.remainderSnapshot?.unit||'')+'）</div>' : "";
      const conflicts = sp.conflicts.length
        ? '<ul style="margin:4px 0 0;padding-left:18px">' + sp.conflicts.map(c => '<li class="conflict-line">'+esc(c.type)+'：'+esc(c.detail)+'</li>').join("") + '</ul>'
        : '<div class="meta">无冲突</div>';

      let editor = "";
      if (!sp.frozen) {
        editor =
          '<div class="row">' +
            '<div><label>深度起(m)</label><input value="'+sp.depthFrom+'" data-k="depthFrom" data-edit="'+sample.id+'|'+sp.id+'"></div>' +
            '<div><label>深度止(m)</label><input value="'+sp.depthTo+'" data-k="depthTo" data-edit="'+sample.id+'|'+sp.id+'"></div>' +
            '<div><label>数量('+esc(sp.unit)+')</label><input value="'+sp.quantity+'" data-k="quantity" data-edit="'+sample.id+'|'+sp.id+'"></div>' +
            '<div><label>用途</label><input value="'+esc(sp.purpose)+'" data-k="purpose" data-edit="'+sample.id+'|'+sp.id+'"></div>' +
            '<button data-save-edit="'+sample.id+'|'+sp.id+'">保存更正</button>' +
          '</div>' +
          '<div class="row"><div><label>外送单位</label><input placeholder="如 华东岩矿测试中心" data-target="'+sample.id+'|'+sp.id+'"></div>' +
          '<div><label>快递单号</label><input data-track="'+sample.id+'|'+sp.id+'"></div>' +
          '<button data-dispatch="'+sample.id+'|'+sp.id+'">登记外送并冻结</button></div>';
      } else {
        editor =
          '<div class="meta">外送：'+esc(sp.dispatch.target)+' · '+esc(sp.dispatch.at)+(sp.dispatch.trackingNo ? " · 单号 "+esc(sp.dispatch.trackingNo) : "")+'</div>' +
          '<div class="row"><div><label>检测项目</label><input placeholder="如 光片鉴定、X衍射" data-items="'+sample.id+'|'+sp.id+'"></div>' +
          '<div><label>检测结论</label><input placeholder="回执结论" data-conc="'+sample.id+'|'+sp.id+'"></div>' +
          '<button data-receipt="'+sample.id+'|'+sp.id+'">登记回执</button></div>';
      }

      let receipts = "";
      if (sp.archivedReceipt) {
        receipts =
          '<div class="archived"><b>已归档结论</b><div class="meta">'+esc(sp.archivedReceipt.items)+'：'+esc(sp.archivedReceipt.conclusion)+'（'+esc(sp.archivedReceipt.at)+'）</div></div>' +
          sp.receipts.filter(r => r.late).map(r => '<div class="late">迟到回执（'+esc(r.at)+'，不改归档）：'+esc(r.items)+' — '+esc(r.conclusion)+'</div>').join("");
      }

      return '<div class="split'+(sp.frozen ? " frozen" : "")+'">'
        + '<div><b>'+esc(sp.id)+'</b> '+frozenNote+' '+(sp.affected ? '<span class="pill affected">受余料更正影响</span>' : "")+' '+conflictPills(sp)+'</div>'
        + '<div class="meta">深度 '+sp.depthFrom+'-'+sp.depthTo+'m · 数量 '+sp.quantity+esc(sp.unit)+' · 用途 '+esc(sp.purpose)+' · 本笔后余量 '+(sp.balanceAfter ?? "—")+'</div>'
        + conflicts + affected + editor + receipts
        + '</div>';
    }

    function renderSample(sample) {
      const rem = sample.remainder;
      const log = sample.conflictLog.length
        ? '<details><summary class="meta">冲突/重算记录（'+sample.conflictLog.length+'）</summary><table><tr><th>时间</th><th>分样</th><th>类型</th><th>说明</th></tr>'
          + sample.conflictLog.slice().reverse().map(c => '<tr><td>'+esc(c.at)+'</td><td>'+esc(c.splitId)+'</td><td>'+esc((c.types||[]).join("、"))+'</td><td>'+esc((c.details||[]).join("；"))+(c.source ? "（"+esc(c.source)+"）" : "")+'</td></tr>').join("")
          + '</table></details>' : '<div class="meta">暂无冲突记录</div>';

      return '<article class="card"><h3>'+esc(sample.id)+' · '+esc(sample.project)+'</h3>'
        + '<div class="meta">'+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · 母样深度 '+esc(sample.depth)+' · '+esc(sample.owner)+'</div>'
        + '<div><span class="pill">余料 '+(rem ? rem.quantity+esc(rem.unit) : "未登记")+'</span></div>'
        + '<div class="row">'
          + '<div><label>'+(rem ? "余料更正为" : "登记余料")+'</label><input placeholder="数量" data-rem-qty="'+sample.id+'"></div>'
          + '<div><label>单位</label><input value="'+esc(rem?.unit || "m")+'" data-rem-unit="'+sample.id+'"></div>'
          + '<div><label>更正原因</label><input placeholder="如 复核复称" data-rem-reason="'+sample.id+'"></div>'
          + '<button data-rem-save="'+sample.id+'">保存并处理分样</button>'
        + '</div>'
        + '<details class="meta"><summary>余料变更史</summary>'+sample.remainderHistory.map(h => esc(h.at)+' → '+h.quantity+esc(h.unit)+'（'+esc(h.reason)+'）').join("<br>")+'</details><hr>'
        + '<h3>新增分样</h3>'
        + '<div class="row">'
          + '<div><label>分样编号</label><input data-sp-id="'+sample.id+'"></div>'
          + '<div><label>深度起(m)</label><input data-sp-from="'+sample.id+'"></div>'
          + '<div><label>深度止(m)</label><input data-sp-to="'+sample.id+'"></div>'
          + '<div><label>数量</label><input data-sp-qty="'+sample.id+'"></div>'
          + '<div><label>单位</label><input value="'+esc(rem?.unit || "m")+'" data-sp-unit="'+sample.id+'"></div>'
          + '<div><label>用途</label><input data-sp-purpose="'+sample.id+'"></div>'
          + '<button data-sp-add="'+sample.id+'">补分样</button>'
        + '</div>'
        + '<div style="display:grid;gap:10px">'+sample.splits.map(sp => renderSplit(sample, sp)).join("")+'</div>'
        + '<hr>'+log
        + '</article>';
    }

    function render() {
      document.querySelector("#samples").innerHTML = samples.length
        ? '<div style="display:grid;gap:16px">'+samples.map(renderSample).join("")+'</div>'
        : '<div class="meta">暂无母样</div>';
    }

    async function load() {
      samples = await api("/api/ledger/samples");
      render();
    }

    function val(sel) { const el = document.querySelector(sel); return el ? el.value.trim() : ""; }

    document.addEventListener("click", async ev => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      try {
        if (btn.id === "reload") return load();
        let m;
        if (m = btn.dataset.remSave) {
          await api("/api/ledger/samples/"+encodeURIComponent(m)+"/remainder", { method: "POST", body: JSON.stringify({
            quantity: Number(val('[data-rem-qty="'+m+'"]')), unit: val('[data-rem-unit="'+m+'"]'), reason: val('[data-rem-reason="'+m+'"]')
          }) });
          toast("余料已保存：未外送分样重算，已外送保留旧档");
        } else if (m = btn.dataset.spAdd) {
          await api("/api/ledger/samples/"+encodeURIComponent(m)+"/splits", { method: "POST", body: JSON.stringify({
            id: val('[data-sp-id="'+m+'"]'), depthFrom: Number(val('[data-sp-from="'+m+'"]')), depthTo: Number(val('[data-sp-to="'+m+'"]')),
            quantity: Number(val('[data-sp-qty="'+m+'"]')), unit: val('[data-sp-unit="'+m+'"]'), purpose: val('[data-sp-purpose="'+m+'"]')
          }) });
          toast("分样已登记（冲突会保留原记录并说明）");
        } else if (m = btn.dataset.dispatch) {
          const [sid, spid] = m.split("|");
          await api("/api/ledger/samples/"+encodeURIComponent(sid)+"/splits/"+encodeURIComponent(spid)+"/dispatch", { method: "POST", body: JSON.stringify({
            target: val('[data-target="'+m+'"]'), trackingNo: val('[data-track="'+m+'"]')
          }) });
          toast("分样已外送并冻结");
        } else if (m = btn.dataset.receipt) {
          const [sid, spid] = m.split("|");
          await api("/api/ledger/samples/"+encodeURIComponent(sid)+"/splits/"+encodeURIComponent(spid)+"/receipts", { method: "POST", body: JSON.stringify({
            items: val('[data-items="'+m+'"]'), conclusion: val('[data-conc="'+m+'"]')
          }) });
          toast("回执已登记（迟到回执不改已归档结论）");
        } else if (m = btn.dataset.saveEdit) {
          const [sid, spid] = m.split("|");
          const payload = {};
          document.querySelectorAll('[data-edit="'+m+'"]').forEach(inp => { payload[inp.dataset.k] = inp.dataset.k === "purpose" ? inp.value : Number(inp.value); });
          await api("/api/ledger/samples/"+encodeURIComponent(sid)+"/splits/"+encodeURIComponent(spid), { method: "PATCH", body: JSON.stringify(payload) });
          toast("未外送分样已更正并重算");
        }
        await load();
      } catch (e) {
        toast(e.message, true);
      }
    });

    load();
  </script>
</body>
</html>`;
