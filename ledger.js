// 台账领域规则：只操作内存对象，不做 HTTP 与文件 IO。
// 职责：母样余料登记/更正、分样核验（区间重叠 / 超出余料 / 编号重复）、
//       外送冻结、回执归档、更正后的重算与影响标记。

export class LedgerError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const round2 = n => Math.round(n * 100) / 100;

// 解析 "128.4-128.8m" 这类深度区间，返回 [起点, 终点]
export function parseDepth(text) {
  if (typeof text !== "string") throw new LedgerError(400, "invalid_depth", "深度格式应为 起-止m，如 128.4-128.8m");
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*m?$/i);
  if (!m) throw new LedgerError(400, "invalid_depth", `深度格式无法识别：${text}`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!(to > from)) throw new LedgerError(400, "invalid_depth", `深度区间起止无效：${text}`);
  return [from, to];
}

// 半开区间 [aFrom, aTo) 与 [bFrom, bTo) 相交（仅相接不算重叠）
export function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

export function findSample(db, sampleId) {
  const sample = db.samples.find(s => s.id === sampleId);
  if (!sample) throw new LedgerError(404, "sample_not_found", `母样不存在：${sampleId}`);
  return sample;
}

// 允许编号重复的分样共存，因此 find 返回全部匹配
export function findSplits(sample, splitId) {
  return sample.splits.filter(sp => sp.id === splitId);
}

function pickSplit(sample, splitId, { requireFrozen } = {}) {
  const all = findSplits(sample, splitId);
  if (!all.length) throw new LedgerError(404, "split_not_found", `分样不存在：${splitId}`);
  if (requireFrozen) {
    const frozen = all.find(sp => sp.frozen);
    if (!frozen) throw new LedgerError(409, "split_not_dispatched", `分样 ${splitId} 尚未外送，不能登记回执`);
    return frozen;
  }
  const editable = all.find(sp => !sp.frozen);
  if (!editable) throw new LedgerError(409, "split_frozen", `分样 ${splitId} 已外送冻结，台账不可修改`);
  return editable;
}

// 兼容旧数据：补齐台账字段
export function ensureLedger(sample) {
  if (!sample.remainder) sample.remainder = null;
  if (!Array.isArray(sample.remainderHistory)) sample.remainderHistory = [];
  if (!Array.isArray(sample.conflictLog)) sample.conflictLog = [];
  if (!Array.isArray(sample.splits)) sample.splits = [];
  for (const sp of sample.splits) {
    if (!Array.isArray(sp.conflicts)) sp.conflicts = [];
    if (!Array.isArray(sp.receipts)) sp.receipts = [];
    if (typeof sp.frozen !== "boolean") sp.frozen = sp.status === "已外送";
    if (!sp.dispatch) sp.dispatch = null;
    if (!sp.archivedReceipt) sp.archivedReceipt = null;
    if (!sp.remainderSnapshot) sp.remainderSnapshot = null;
    if (typeof sp.affected !== "boolean") sp.affected = false;
    if (!Array.isArray(sp.affectedByCorrections)) sp.affectedByCorrections = [];
    if (typeof sp.balanceAfter !== "number") sp.balanceAfter = null;
  }
  return sample;
}

// ---------- 母样余料 ----------

// 登记或更正母样余料。更正后：未外送分样重算；已外送分样保留旧档并标出受影响。
export function registerRemainder(db, sampleId, input) {
  const sample = ensureLedger(findSample(db, sampleId));
  const quantity = Number(input.quantity);
  const unit = String(input.unit || sample.remainder?.unit || "m").trim();
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new LedgerError(400, "invalid_quantity", "余料数量必须是非负数字");
  }
  if (sample.remainder && unit !== sample.remainder.unit) {
    throw new LedgerError(400, "unit_mismatch", `余料单位必须与既有单位一致：${sample.remainder.unit}`);
  }

  const oldQuantity = sample.remainder ? sample.remainder.quantity : null;
  const at = new Date().toISOString();
  sample.remainder = { quantity: round2(quantity), unit, updatedAt: at };
  sample.remainderHistory.push({
    at,
    quantity: round2(quantity),
    unit,
    reason: input.reason || (oldQuantity === null ? "母样登记余料" : "母样余料更正")
  });

  const recalc = recompute(sample, { at, markAffected: oldQuantity !== null });
  return { sample, ...recalc };
}

// ---------- 分样 ----------

// 新增分样。区间重叠 / 超出余料 / 编号重复时，记录保留并在 conflicts 中说明冲突。
// 深度本身格式或越界错误拒绝录入（400），不产生台账记录。
export function addSplit(db, sampleId, input) {
  const sample = ensureLedger(findSample(db, sampleId));
  const id = String(input.id || "").trim();
  const purpose = String(input.purpose || "").trim();
  const quantity = Number(input.quantity);
  if (!id) throw new LedgerError(400, "missing_id", "分样编号必填");
  if (!purpose) throw new LedgerError(400, "missing_purpose", "用途必填");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new LedgerError(400, "invalid_quantity", "分样数量必须为正数");

  let from, to;
  if (input.depthFrom != null && input.depthTo != null) {
    from = Number(input.depthFrom);
    to = Number(input.depthTo);
  } else {
    [from, to] = parseDepth(input.depth);
  }
  if (!(to > from)) throw new LedgerError(400, "invalid_depth", "深度区间起止无效");

  // 与母样取样深度核对（越界是录入错误，直接拒绝）
  const [pFrom, pTo] = parseDepth(sample.depth);
  if (from < pFrom - 1e-9 || to > pTo + 1e-9) {
    throw new LedgerError(400, "depth_out_of_parent", `深度 ${from}-${to}m 超出母样区间 ${sample.depth}`);
  }

  const unit = String(input.unit || sample.remainder?.unit || "m").trim();
  if (sample.remainder && unit !== sample.remainder.unit) {
    throw new LedgerError(400, "unit_mismatch", `数量单位必须与余料单位一致：${sample.remainder.unit}`);
  }

  const now = new Date().toISOString();
  const split = {
    id,
    depthFrom: from,
    depthTo: to,
    quantity: round2(quantity),
    unit,
    purpose,
    createdAt: now,
    status: "在库",
    frozen: false,
    conflicts: [],
    balanceAfter: null,
    dispatch: null,
    remainderSnapshot: null,
    archivedReceipt: null,
    receipts: [],
    affected: false,
    affectedByCorrections: []
  };
  sample.splits.push(split);

  const conflicts = [];
  // 1) 编号重复：保留原记录，说明冲突
  if (sample.splits.filter(sp => sp.id === id).length > 1) {
    conflicts.push({ type: "编号重复", detail: `分样编号 ${id} 在母样 ${sample.id} 下重复，原记录保留，台账按创建顺序共存`, at: now });
  }
  // 2) 区间重叠
  for (const other of sample.splits) {
    if (other === split) continue;
    if (overlaps(from, to, other.depthFrom, other.depthTo)) {
      conflicts.push({ type: "区间重叠", detail: `与分样 ${other.id}（${other.depthFrom}-${other.depthTo}m）深度区间重叠，原记录保留`, at: now });
    }
  }
  // 3) 超出余料：按“已冻结分样先扣 + 在库分样按顺序累计”核定
  const idx = sample.splits.indexOf(split);
  const frozenUsed = sample.splits.slice(0, idx).filter(sp => sp.frozen).reduce((n, sp) => n + sp.quantity, 0);
  const queuedBefore = sample.splits.slice(0, idx).filter(sp => !sp.frozen).reduce((n, sp) => n + sp.quantity, 0);
  const remaining = sample.remainder ? sample.remainder.quantity - frozenUsed - queuedBefore - split.quantity : null;
  split.balanceAfter = remaining === null ? null : round2(remaining);
  if (sample.remainder && remaining < -1e-9) {
    conflicts.push({
      type: "超出余料",
      detail: `分样 ${round2(quantity)}${unit}，超出当时可用余料（余料 ${sample.remainder.quantity}${unit}，已外送占用 ${round2(frozenUsed)}，本笔后差额 ${round2(remaining)}），原记录保留`,
      at: now
    });
  }

  split.conflicts.push(...conflicts);
  if (conflicts.length) sample.conflictLog.push({ at: now, splitId: id, types: conflicts.map(c => c.type), details: conflicts.map(c => c.detail) });
  return split;
}

// 编辑仅允许未外送分样；外送后冻结
export function updateSplit(db, sampleId, splitId, input) {
  const sample = ensureLedger(findSample(db, sampleId));
  const split = pickSplit(sample, splitId);
  if (split.frozen) throw new LedgerError(409, "split_frozen", `分样 ${splitId} 已外送冻结，台账不可修改（如需更正请改母样余料）`);

  if (input.purpose != null) {
    const purpose = String(input.purpose).trim();
    if (!purpose) throw new LedgerError(400, "missing_purpose", "用途不能为空");
    split.purpose = purpose;
  }
  if (input.quantity != null) {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new LedgerError(400, "invalid_quantity", "分样数量必须为正数");
    split.quantity = round2(quantity);
  }
  if (input.depthFrom != null || input.depthTo != null || input.depth != null) {
    let from, to;
    if (input.depth != null) {
      [from, to] = parseDepth(input.depth);
    } else {
      from = Number(input.depthFrom ?? split.depthFrom);
      to = Number(input.depthTo ?? split.depthTo);
      if (!(to > from)) throw new LedgerError(400, "invalid_depth", "深度区间起止无效");
    }
    const [pFrom, pTo] = parseDepth(sample.depth);
    if (from < pFrom - 1e-9 || to > pTo + 1e-9) throw new LedgerError(400, "depth_out_of_parent", `深度 ${from}-${to}m 超出母样区间 ${sample.depth}`);
    split.depthFrom = from;
    split.depthTo = to;
  }
  recompute(sample);
  return split;
}

// ---------- 外送 ----------

// 外送后冻结该分样
export function dispatchSplit(db, sampleId, splitId, input = {}) {
  const sample = ensureLedger(findSample(db, sampleId));
  const split = pickSplit(sample, splitId);
  if (split.frozen) throw new LedgerError(409, "split_frozen", `分样 ${splitId} 已外送，不能重复外送`);

  const at = new Date().toISOString();
  split.frozen = true;
  split.status = "已外送";
  split.dispatch = {
    at,
    target: String(input.target || "").trim() || "未记录",
    courier: input.courier ? String(input.courier).trim() : "",
    trackingNo: input.trackingNo ? String(input.trackingNo).trim() : "",
    note: input.note ? String(input.note).trim() : ""
  };
  // 冻结时刻的余料快照：之后母样余料更正也不改旧档
  split.remainderSnapshot = sample.remainder ? { ...sample.remainder } : null;
  recompute(sample);
  return split;
}

// ---------- 回执 ----------

// 回执写明检测项目和结论。首份回执归档；迟到回执只追加，不能改掉已归档结论。
export function addReceipt(db, sampleId, splitId, input) {
  const sample = ensureLedger(findSample(db, sampleId));
  const split = pickSplit(sample, splitId, { requireFrozen: true });
  if (!split.frozen) throw new LedgerError(409, "split_not_dispatched", `分样 ${splitId} 尚未外送，不能登记回执`);

  const items = String(input.items || "").trim();
  const conclusion = String(input.conclusion || "").trim();
  if (!items) throw new LedgerError(400, "missing_items", "检测项目必填");
  if (!conclusion) throw new LedgerError(400, "missing_conclusion", "检测结论必填");

  const at = new Date().toISOString();
  const receipt = { at, items, conclusion, late: !!split.archivedReceipt };
  split.receipts.push(receipt);
  if (!split.archivedReceipt) {
    split.archivedReceipt = { at, items, conclusion };
  }
  return { split, receipt };
}

// ---------- 重算 ----------

// 按创建顺序重算未外送分样的区间重叠 / 超出余料状态与剩余量。
// 已外送分样保留旧档；余料更正时若旧档结论所依据的余料已变，则标出受影响。
export function recompute(sample, { at = new Date().toISOString(), markAffected = false } = {}) {
  ensureLedger(sample);
  const frozen = sample.splits.filter(sp => sp.frozen);
  const pending = sample.splits.filter(sp => !sp.frozen);
  const frozenUsed = round2(frozen.reduce((n, sp) => n + sp.quantity, 0));
  const base = sample.remainder ? sample.remainder.quantity : null;

  // 已外送：不动冲突与旧档，只在更正场景下评估是否受影响
  const affected = [];
  if (markAffected && sample.remainder) {
    for (const sp of frozen) {
      const snapshotQty = sp.remainderSnapshot ? sp.remainderSnapshot.quantity : null;
      const changed = snapshotQty !== null && Math.abs(snapshotQty - sample.remainder.quantity) > 1e-9;
      if (changed && !sp.affected) {
        sp.affected = true;
        sp.affectedByCorrections.push({ at, remainderNow: sample.remainder.quantity, remainderAtDispatch: snapshotQty, unit: sample.remainder.unit });
        affected.push(sp.id);
      }
    }
  }

  // 未外送：重算
  let allocated = frozenUsed;
  const recalculated = [];
  for (const sp of pending) {
    const kept = sp.conflicts.filter(c => c.type === "编号重复");
    const hadOver = sp.conflicts.some(c => c.type === "区间重叠");
    const hadOverQty = sp.conflicts.some(c => c.type === "超出余料");

    const overlapConflicts = [];
    for (const other of sample.splits) {
      if (other === sp) continue;
      if (overlaps(sp.depthFrom, sp.depthTo, other.depthFrom, other.depthTo)) {
        overlapConflicts.push({ type: "区间重叠", detail: `与分样 ${other.id}（${other.depthFrom}-${other.depthTo}m）深度区间重叠，原记录保留`, at: sp.conflicts.find(c => c.type === "区间重叠")?.at || at });
      }
    }

    const remaining = base === null ? null : round2(base - allocated - sp.quantity);
    sp.balanceAfter = remaining;
    const overQty = base !== null && remaining < -1e-9;
    const qtyConflicts = overQty
      ? [{ type: "超出余料", detail: `余料更正后重算：分样 ${sp.quantity}${sp.unit}，可用余料 ${round2(base - allocated)}，差额 ${remaining}，原记录保留`, at }]
      : [];

    sp.conflicts = [...kept, ...overlapConflicts, ...qtyConflicts];
    allocated = round2(allocated + sp.quantity);
    recalculated.push(sp.id);

    const types = [];
    if (overlapConflicts.length && !hadOver) types.push("区间重叠");
    if (overQty && !hadOverQty) types.push("超出余料");
    if (types.length) {
      sample.conflictLog.push({ at, splitId: sp.id, types, details: sp.conflicts.filter(c => types.includes(c.type)).map(c => c.detail), source: "余料更正重算" });
    }
  }

  return { frozenUsed, recalculated, affected };
}
