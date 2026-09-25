import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSample,
  findSplit,
  registerRemainder,
  addSplit,
  shipSplit,
  submitReceipt,
  correctRemainder,
  CONFLICT
} from "../src/domain/ledger.js";

const T = "2026-09-25T00:00:00.000Z";

function newSample() {
  return normalizeSample({
    id: "CORE-T",
    project: "测试矿段",
    borehole: "ZK-T",
    coreBox: "BX-T",
    depth: "100.0-101.0m",
    owner: "测试员",
    slices: []
  });
}

test("未登记余料不能分样；登记后可以分样", () => {
  const s = newSample();
  assert.throws(() => addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "外送" }, T), { code: "remainderRequired" });
  registerRemainder(s, { total: 1, unit: "m", note: "整段" }, T);
  const sp = addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "外送" }, T);
  assert.deepEqual(sp.conflicts, []);
});

test("区间重叠 / 超出余料 / 编号重复：记录保留并标注全部冲突", () => {
  const s = newSample();
  registerRemainder(s, { total: 0.5, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.3, quantity: 0.3, purpose: "p" }, T);
  const bad = addSplit(s, { id: "A", depthFrom: 100.2, depthTo: 100.4, quantity: 0.4, purpose: "p" }, T, [s]);
  assert.equal(s.splits.length, 2); // 冲突不拒绝，原记录保留
  assert.ok(bad.conflicts.includes(CONFLICT.OVERLAP));
  assert.ok(bad.conflicts.includes(CONFLICT.DUPLICATE));
  assert.ok(bad.conflicts.includes(CONFLICT.EXCEEDS)); // 0.3+0.4=0.7 > 0.5
  assert.match(bad.conflictNote, /区间重叠/);
});

test("单位必须与母样余料一致", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "kg" }, T);
  assert.throws(() => addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.1, quantity: 1, unit: "m", purpose: "p" }, T), { code: "unitMismatch" });
});

test("外送后冻结，不能重复外送", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "外送" }, T);
  shipSplit(s, "A", T);
  assert.equal(s.splits[0].frozen, true);
  assert.throws(() => shipSplit(s, "A", T), { code: "alreadyShipped" });
});

test("未外送不能登记回执", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "p" }, T);
  assert.throws(() => submitReceipt(s, "A", { items: ["Cu"], conclusion: "合格" }, T), { code: "notShipped" });
});

test("首份回执归档；迟到回执不改已归档结论", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "p" }, T);
  shipSplit(s, "A", "2026-09-10T00:00:00.000Z");
  const r1 = submitReceipt(s, "A", { items: "Cu,Mo", conclusion: "Cu 1.2%", testedAt: "2026-09-12" }, "2026-09-13T00:00:00.000Z");
  assert.equal(r1.archived, true);
  const r2 = submitReceipt(s, "A", { items: ["复测Cu"], conclusion: "Cu 0.9%（外单位复测）", testedAt: "2026-09-20" }, "2026-09-22T00:00:00.000Z");
  assert.equal(r2.archived, false);
  assert.equal(s.splits[0].receipt.conclusion, "Cu 1.2%"); // 已归档结论不变
  assert.equal(s.splits[0].lateReceipts.length, 1);
  assert.match(s.splits[0].lateReceipts[0].note, /迟到回执/);
});

test("余料更正：未外送分样重算冲突，已外送保留旧档并标出受影响", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "外送" }, T);
  addSplit(s, { id: "B", depthFrom: 100.3, depthTo: 100.4, quantity: 0.2, purpose: "内部" }, T);
  assert.deepEqual(s.splits[1].conflicts, []); // 余料充足时无冲突

  shipSplit(s, "A", "2026-09-10T00:00:00.000Z");

  // 盘点发现余料虚报，下调为 0.3m：A+B 共 0.4m，超出余料
  const { correction } = correctRemainder(s, { total: 0.3, unit: "m", reason: "盘点修正：原登记含相邻段" }, "2026-09-20T00:00:00.000Z");
  assert.deepEqual(correction.recomputed, ["B"]);
  assert.deepEqual(correction.affectedShipped, ["A"]);

  const b = s.splits.find((x) => x.id === "B");
  assert.deepEqual(b.conflicts, [CONFLICT.EXCEEDS]); // 未外送：按新余料重算
  assert.equal(b.conflictHistory.length, 2); // 登记核验 + 更正重算留痕

  const a = s.splits.find((x) => x.id === "A");
  assert.equal(a.frozen, true);
  assert.deepEqual(a.conflicts, []); // 已外送：旧档冲突保持原样
  assert.equal(a.affectedByCorrection, true);
  assert.deepEqual(a.affectedInfo.archivedConflicts, []);
  assert.deepEqual(a.affectedInfo.currentConflicts, [CONFLICT.EXCEEDS]);
  assert.equal(s.remainder.total, 0.3);
  assert.equal(s.correctionHistory.length, 1);
});

test("更正必须填写原因且不能无变化", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  assert.throws(() => correctRemainder(s, { total: 1, unit: "m", reason: "" }, T), { code: "reasonRequired" });
  assert.throws(() => correctRemainder(s, { total: 1, unit: "m", reason: "一样" }, T), { code: "unchangedRemainder" });
});

test("编号重复时更正余料：按对象身份排除自身，已外送那份要标出受影响", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  const a = addSplit(s, { id: "DUP", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "外送" }, T);
  addSplit(s, { id: "DUP", depthFrom: 100.2, depthTo: 100.4, quantity: 0.2, purpose: "内部" }, T); // 故意重号+重叠
  shipSplit(s, a.uid, T);
  // 下调余料到 0.3m：两份共 0.4m，均超出；已外送那份不得被重算覆盖
  const { correction } = correctRemainder(s, { total: 0.3, unit: "m", reason: "盘点修正" }, T);
  assert.deepEqual(correction.affectedShipped, ["DUP"], "已外送分样（即便编号重复）应出现在受影响名单");
  const shipped = s.splits.find((x) => x.status === "已外送");
  assert.deepEqual(shipped.conflicts, []); // 旧档冲突原样
  assert.equal(shipped.affectedByCorrection, true);
  assert.deepEqual(shipped.affectedInfo.currentConflicts, [CONFLICT.EXCEEDS]); // 只重算超量，重叠/重号不参与更正判定
});

test("findSplit 支持按内部 uid 精确定位重复编号的分样", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  const a = addSplit(s, { id: "DUP", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "p" }, T);
  const b = addSplit(s, { id: "DUP", depthFrom: 100.3, depthTo: 100.4, quantity: 0.2, purpose: "p" }, T);
  assert.notEqual(a.uid, b.uid);
  assert.equal(findSplit(s, a.uid).uid, a.uid); // uid 精确定位
  assert.equal(findSplit(s, b.uid).uid, b.uid);
  assert.equal(findSplit(s, "DUP").uid, a.uid); // 只有业务编号时定位第一条（兼容旧调用）
});

test("已有分样时禁止更改计量单位", () => {
  const s = newSample();
  registerRemainder(s, { total: 1, unit: "m" }, T);
  addSplit(s, { id: "A", depthFrom: 100, depthTo: 100.2, quantity: 0.2, purpose: "p" }, T);
  assert.throws(() => correctRemainder(s, { total: 1, unit: "kg", reason: "换单位" }, T), { code: "unitChangeBlocked" });
});
