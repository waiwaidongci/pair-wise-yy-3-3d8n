// 端到端：接口层（HTTP）→ 核验层 → 保存层。用完即弃，不写入正式数据（配合 DB_PATH 指向临时库）。
const BASE = process.env.BASE || "http://localhost:3099";
let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  ok  ${name} ${extra}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
}
async function req(method, path, payload) {
  const res = await fetch(BASE + path, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

const SID = "CORE-002";
const B = `/api/samples/${SID}`;

console.log("① 未登记余料禁止分样");
let r = await req("POST", `${B}/splits`, { id: "X", depthFrom: 45.1, depthTo: 45.3, quantity: 0.2, purpose: "Au" });
check("返回 409", r.status === 409, `status=${r.status}`);

console.log("② 登记母样余料");
r = await req("POST", `${B}/remainder`, { total: 0.8, unit: "m", note: "整段余芯" });
check("余料已登记", r.status === 200 && r.data.remainder.total === 0.8);

console.log("③ 正常分样：写明深度、数量、用途");
r = await req("POST", `${B}/splits`, { id: "FY-2-A", depthFrom: 45.1, depthTo: 45.3, quantity: 0.2, purpose: "外送Au分析" });
const uidA = r.data.split?.uid;
check("无冲突且字段完整", r.status === 201 && r.data.split.conflicts.length === 0
  && r.data.split.depth === "45.1-45.3m" && r.data.split.quantity === 0.2
  && r.data.split.unit === "m" && r.data.split.purpose === "外送Au分析" && Boolean(uidA), `uid=${uidA}`);

console.log("④ 冲突分样：区间重叠 + 编号重复 + 超出余料 —— 保留原记录并说明冲突");
r = await req("POST", `${B}/splits`, { id: "FY-2-A", depthFrom: 45.2, depthTo: 45.4, quantity: 0.8, purpose: "内部" });
check("冲突不拒绝（201）", r.status === 201);
check("三类冲突齐全", JSON.stringify(r.data.split.conflicts) === JSON.stringify(["interval_overlap", "duplicate_id", "exceeds_remainder"]), JSON.stringify(r.data.split.conflicts));
check("冲突说明写明保留原记录", /原记录已保留/.test(r.data.split.conflictNote || ""));

console.log("⑤ 外送后冻结（按内部 uid 精确定位重复编号的分样）");
r = await req("POST", `${B}/splits/${uidA}/ship`, {});
const shipped = r.data.splits?.find((x) => x.uid === uidA);
check("已外送且 frozen", shipped?.status === "已外送" && shipped?.frozen === true);

console.log("⑥ 重复外送被拒绝");
r = await req("POST", `${B}/splits/${uidA}/ship`, {});
check("返回 409", r.status === 409, `status=${r.status}`);

console.log("⑦ 首份回执：检测项目 + 结论，归档");
r = await req("POST", `${B}/splits/${uidA}/receipt`, { items: "Au,Ag", conclusion: "Au 2.1g/t", testedAt: "2026-09-23" });
check("归档成功", r.data.archived === true && r.data.split.receipt.items.join("/") === "Au/Ag" && r.data.split.receipt.conclusion === "Au 2.1g/t");

console.log("⑧ 迟到回执不能改掉已归档结论");
r = await req("POST", `${B}/splits/${uidA}/receipt`, { items: ["复测Au"], conclusion: "Au 3.0 外单位复测", testedAt: "2026-09-24" });
check("只附注不覆盖", r.data.archived === false && r.data.split.receipt.conclusion === "Au 2.1g/t" && r.data.split.lateReceipts.length === 1);

console.log("⑨ 母样余料更正（0.8→0.3）：未外送重算，已外送保留旧档并标出受影响");
r = await req("POST", `${B}/correct-remainder`, { total: 0.3, reason: "盘点修正：原登记含相邻段" });
const a = r.data.sample.splits.find((x) => x.uid === uidA);
const p = r.data.sample.splits.find((x) => x.status === "未外送");
check("更正留痕", r.status === 200 && r.data.sample.remainder.total === 0.3 && r.data.sample.correctionHistory.length === 1);
check("未外送分样冲突集未变化则不列入重算", JSON.stringify(r.data.recomputed) === "[]", JSON.stringify(r.data.recomputed));
check("已外送分样列入受影响（重号也不漏）", JSON.stringify(r.data.affectedShipped) === JSON.stringify(["FY-2-A"]), JSON.stringify(r.data.affectedShipped));
check("已外送旧档冲突保持原样", JSON.stringify(a.conflicts) === "[]", JSON.stringify(a.conflicts));
check("已外送标出按新余料的超量判定（重叠/重号不参与更正）", a.affectedByCorrection === true
  && JSON.stringify(a.affectedInfo.currentConflicts) === JSON.stringify(["exceeds_remainder"]),
  JSON.stringify(a.affectedInfo?.currentConflicts));
check("已外送归档结论仍不可变", a.receipt.conclusion === "Au 2.1g/t" && a.frozen === true);
check("未外送分样原冲突保留", JSON.stringify(p.conflicts) === JSON.stringify(["interval_overlap", "duplicate_id", "exceeds_remainder"]), JSON.stringify(p.conflicts));

console.log("⑨b 另一母样：上调余料后未外送分样冲突解除（真正的重算路径）");
const B1 = "/api/samples/CORE-001";
r = await req("POST", `${B1}/correct-remainder`, { total: 1, reason: "盘点补记：整段均可作余料" });
const fy2 = r.data.sample.splits.find((x) => x.id === "FY-001-2");
check("FY-001-2 由超量+重叠重算为仅重叠", JSON.stringify(r.data.recomputed) === JSON.stringify(["FY-001-2"])
  && JSON.stringify(fy2.conflicts) === JSON.stringify(["interval_overlap"]),
  `recomputed=${JSON.stringify(r.data.recomputed)} conflicts=${JSON.stringify(fy2.conflicts)}`);
check("重算过程在 conflictHistory 留痕", fy2.conflictHistory.length === 2
  && JSON.stringify(fy2.conflictHistory[1].to) === JSON.stringify(["interval_overlap"]));
check("已外送 FY-001-1 未受影响（新旧判定一致）", JSON.stringify(r.data.affectedShipped) === "[]", JSON.stringify(r.data.affectedShipped));

console.log("⑩ 更正校验：缺原因 400、无变化 400、有分样时改单位 400");
r = await req("POST", `${B}/correct-remainder`, { total: 0.3, reason: "" });
check("缺原因 400", r.status === 400, `status=${r.status}`);
r = await req("POST", `${B}/correct-remainder`, { total: 0.3, reason: "一样" });
check("无变化 400", r.status === 400, `status=${r.status}`);
r = await req("POST", `${B}/correct-remainder`, { total: 0.3, unit: "kg", reason: "换单位" });
check("改单位 400", r.status === 400, `status=${r.status}`);

console.log(`\nE2E ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
