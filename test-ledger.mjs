// 台账规则核验：直接调用 ledger.js 的纯函数，不触碰数据文件。
import {
  registerRemainder, addSplit, updateSplit, dispatchSplit, addReceipt, parseDepth, LedgerError
} from "./ledger.js";

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error("✗ " + name); process.exitCode = 1; }
  else { passed++; console.log("✓ " + name); }
}
function throws(fn, code, name) {
  try { fn(); } catch (e) { return ok(e.code === code, `${name}（${code}）`); }
  console.error("✗ " + name + "：未抛错"); process.exitCode = 1;
}

// 深度解析
{
  const [a, b] = parseDepth("128.4-128.8m");
  ok(a === 128.4 && b === 128.8, "解析深度区间");
  throws(() => parseDepth("128.9-128.8m"), "invalid_depth", "起止倒置被拒绝");
}

// 构造内存母样
const db = { samples: [{ id: "CORE-T1", project: "测试", borehole: "ZK-1", coreBox: "B1", depth: "100.0-101.0m", owner: "甲", slices: [] }] };

// 母样登记余料
registerRemainder(db, "CORE-T1", { quantity: 0.5, unit: "m" });
const s = db.samples[0];
ok(s.remainder.quantity === 0.5, "母样登记余料");
ok(s.remainderHistory.at(-1).reason === "母样登记余料", "余料登记写入变更史");

// 正常分样：深度、数量、用途
const sp1 = addSplit(db, "CORE-T1", { id: "SP-1", depthFrom: 100.1, depthTo: 100.2, quantity: 0.1, unit: "m", purpose: "光片" });
ok(sp1.conflicts.length === 0 && sp1.balanceAfter === 0.4, "正常分样无冲突并计算余量");

// 区间重叠（保留原记录 + 说明冲突）
const sp2 = addSplit(db, "CORE-T1", { id: "SP-2", depthFrom: 100.15, depthTo: 100.25, quantity: 0.1, purpose: "X衍射" });
ok(sp2.conflicts.some(c => c.type === "区间重叠"), "区间重叠被标出且记录保留");
ok(s.splits.length === 2, "重叠分样仍保留原记录");

// 编号重复（保留共存）
const dup = addSplit(db, "CORE-T1", { id: "SP-1", depthFrom: 100.3, depthTo: 100.35, quantity: 0.1, purpose: "复查" });
ok(dup.conflicts.some(c => c.type === "编号重复"), "编号重复被标出");
ok(s.splits.filter(x => x.id === "SP-1").length === 2, "重复编号记录共存保留");

// 超出母样区间直接拒绝（录入错误，不留记录）
throws(() => addSplit(db, "CORE-T1", { id: "SP-X", depthFrom: 100.9, depthTo: 101.2, quantity: 0.01, purpose: "x" }), "depth_out_of_parent", "深度超出母样区间拒绝录入");

// 超出余料：已 0.1+0.1+0.1=0.3，再取 0.3 → 余量 -0.1
const over = addSplit(db, "CORE-T1", { id: "SP-3", depthFrom: 100.4, depthTo: 100.7, quantity: 0.3, purpose: "化学分析" });
ok(over.conflicts.some(c => c.type === "超出余料") && over.balanceAfter === -0.1, "超出余料被标出且记录保留");

// 外送冻结：冻结后不能改、不能重复外送
const dispatched = dispatchSplit(db, "CORE-T1", "SP-2", { target: "华东测试中心", trackingNo: "SF123" });
ok(dispatched.frozen && dispatched.status === "已外送", "外送后分样冻结");
ok(dispatched.remainderSnapshot.quantity === 0.5, "冻结时留存余料快照");
throws(() => updateSplit(db, "CORE-T1", "SP-2", { purpose: "改用途" }), "split_frozen", "已外送分样禁止修改");
throws(() => dispatchSplit(db, "CORE-T1", "SP-2", { target: "别处" }), "split_frozen", "已外送分样禁止重复外送");

// 未外送分样可改
const edited = updateSplit(db, "CORE-T1", "SP-3", { quantity: 0.05 });
ok(edited.quantity === 0.05 && !edited.conflicts.some(c => c.type === "超出余料"), "未外送分样可更正并触发重算清除冲突");

// 回执：首份归档
addReceipt(db, "CORE-T1", "SP-2", { items: "光片鉴定", conclusion: "见黄铜矿化" });
ok(s.splits.find(x => x === dispatched).archivedReceipt.conclusion === "见黄铜矿化", "首份回执写检测项目与结论并归档");
// 迟到回执不能改掉已归档结论
addReceipt(db, "CORE-T1", "SP-2", { items: "复查", conclusion: "迟到的不同结论" });
ok(dispatched.archivedReceipt.conclusion === "见黄铜矿化", "迟到回执不改已归档结论");
ok(dispatched.receipts.length === 2 && dispatched.receipts[1].late === true, "迟到回执标记并保留");
throws(() => addReceipt(db, "CORE-T1", "SP-1", { items: "x", conclusion: "y" }), "split_not_dispatched", "未外送分样不能登记回执");

// 母样余料更正：余料调小 → 在库分样重算，已外送保留旧档并标受影响
registerRemainder(db, "CORE-T1", { quantity: 0.15, reason: "复称更正" });
ok(s.remainder.quantity === 0.15 && s.remainderHistory.length === 2, "余料更正写入变更史");
ok(dispatched.frozen && dispatched.archivedReceipt.conclusion === "见黄铜矿化", "已外送分样旧档保持不变");
ok(dispatched.remainderSnapshot.quantity === 0.5 && dispatched.affected === true, "已外送分样标出受余料更正影响");
const sp3 = s.splits.find(x => x.id === "SP-3" && !x.frozen);
ok(sp3.conflicts.some(c => c.type === "超出余料"), "更正后未外送分样重算超出余料");
ok(s.conflictLog.some(c => c.source === "余料更正重算"), "重算冲突进入冲突记录");

// 余料调大：冲突解除，已外送的受影响标记仍在（旧档不改）
registerRemainder(db, "CORE-T1", { quantity: 0.8, reason: "余料补登" });
ok(!sp3.conflicts.some(c => c.type === "超出余料"), "余料补足后未外送分样冲突解除");
ok(dispatched.affected === true, "已外送分样保留受影响标记");

// 单位不一致拒绝
throws(() => registerRemainder(db, "CORE-T1", { quantity: 1, unit: "kg" }), "unit_mismatch", "余料单位变更被拒绝");

console.log(`\n${passed} 项通过`);
