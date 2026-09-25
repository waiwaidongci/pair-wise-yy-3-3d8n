// 分样与外送台账——核验与业务规则层（纯函数，不接触 HTTP 与文件）
// 职责：区间核验、余料核验、编号去重、外送冻结、回执归档、更正重算。

export const UNITS = ["m", "kg", "g", "袋", "块"];
export const SPLIT_PENDING = "未外送";
export const SPLIT_SHIPPED = "已外送";

export const CONFLICT = {
  OVERLAP: "interval_overlap", // 区间重叠
  EXCEEDS: "exceeds_remainder", // 超出余料
  DUPLICATE: "duplicate_id" // 编号重复
};

export const CONFLICT_LABEL = {
  [CONFLICT.OVERLAP]: "区间重叠",
  [CONFLICT.EXCEEDS]: "超出余料",
  [CONFLICT.DUPLICATE]: "编号重复"
};

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

// 错误码到 HTTP 状态码的映射由接口层持有，核验层不感知传输
export const ERROR_STATUS = {
  sampleNotFound: 404,
  splitNotFound: 404,
  invalidRemainderTotal: 400,
  invalidUnit: 400,
  invalidSplitId: 400,
  invalidDepthRange: 400,
  invalidQuantity: 400,
  purposeRequired: 400,
  unitMismatch: 400,
  receiptItemsRequired: 400,
  conclusionRequired: 400,
  reasonRequired: 400,
  unchangedRemainder: 400,
  unitChangeBlocked: 400,
  remainderRegistered: 409,
  remainderRequired: 409,
  remainderNotRegistered: 409,
  alreadyShipped: 409,
  notShipped: 409
};

const num = (value) => {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? n : NaN;
};

/** 解析 "128.4-128.8m" / "128.4 ~ 128.8" 形式的深度区间（米） */
export function parseDepth(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*(?:-|~|—|–|至)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

export function intervalsOverlap(a, b) {
  return Boolean(a && b) && a.from < b.to && b.from < a.to;
}

function sameSet(a = [], b = []) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function conflictText(conflicts = []) {
  return conflicts.map((c) => CONFLICT_LABEL[c] || c).join("、");
}

/** 旧数据补台账字段（幂等迁移） */
export function normalizeSample(sample) {
  if (sample.remainder === undefined) sample.remainder = null;
  if (!Array.isArray(sample.splits)) sample.splits = [];
  if (!Array.isArray(sample.correctionHistory)) sample.correctionHistory = [];
  for (let i = 0; i < sample.splits.length; i += 1) {
    const split = sample.splits[i];
    if (!split.uid) split.uid = `SP-legacy-${sample.id || "X"}-${i + 1}`;
    if (!Array.isArray(split.conflicts)) split.conflicts = [];
    if (!Array.isArray(split.conflictHistory)) split.conflictHistory = [];
    if (!Array.isArray(split.lateReceipts)) split.lateReceipts = [];
    if (split.receipt === undefined) split.receipt = null;
    if (typeof split.frozen !== "boolean") split.frozen = split.status === SPLIT_SHIPPED;
    if (split.affectedByCorrection === undefined) split.affectedByCorrection = false;
  }
  return sample;
}

export function findSample(samples, id) {
  const sample = samples.find((item) => item.id === id);
  if (!sample) throw new LedgerError("sampleNotFound", `母样 ${id} 不存在`);
  return normalizeSample(sample);
}

export function findSplit(sample, ref) {
  const split = sample.splits.find((item) => item.uid === ref || item.id === ref);
  if (!split) throw new LedgerError("splitNotFound", `分样 ${ref} 不存在`);
  return split;
}

/* ---------------- 母样：余料登记 / 更正 ---------------- */

export function registerRemainder(sample, input = {}, at) {
  normalizeSample(sample);
  if (sample.remainder) {
    throw new LedgerError("remainderRegistered", "余料已登记，如需变更请使用“余料更正”");
  }
  const total = num(input.total);
  if (!Number.isFinite(total) || total <= 0) {
    throw new LedgerError("invalidRemainderTotal", "余料数量必须为大于 0 的数字");
  }
  const unit = (input.unit || "").trim();
  if (!UNITS.includes(unit)) {
    throw new LedgerError("invalidUnit", `余料单位必须是：${UNITS.join("、")}`);
  }
  sample.remainder = {
    total,
    unit,
    note: (input.note || "").trim(),
    registeredAt: at
  };
  return sample;
}

/**
 * 余料更正：
 *  - 未外送分样：按新余料重算冲突（旧档保留在 conflictHistory）
 *  - 已外送分样：冻结旧档不动，仅在新旧判定不一致时标出受影响
 */
export function correctRemainder(sample, input = {}, at) {
  normalizeSample(sample);
  if (!sample.remainder) {
    throw new LedgerError("remainderNotRegistered", "余料尚未登记，不能更正");
  }
  const total = num(input.total);
  if (!Number.isFinite(total) || total <= 0) {
    throw new LedgerError("invalidRemainderTotal", "余料数量必须为大于 0 的数字");
  }
  const reason = (input.reason || "").trim();
  if (!reason) throw new LedgerError("reasonRequired", "更正余料必须填写原因");

  const unit = (input.unit || sample.remainder.unit).trim();
  if (!UNITS.includes(unit)) {
    throw new LedgerError("invalidUnit", `余料单位必须是：${UNITS.join("、")}`);
  }
  const usedUnits = new Set(sample.splits.map((s) => s.unit));
  if (unit !== sample.remainder.unit && usedUnits.size > 0) {
    throw new LedgerError(
      "unitChangeBlocked",
      "已有分样时不能更改计量单位（分样与余料单位必须一致），请新建母样处理"
    );
  }
  if (total === sample.remainder.total && unit === sample.remainder.unit) {
    throw new LedgerError("unchangedRemainder", "更正后的余料与当前余料一致，无需更正");
  }

  const from = { total: sample.remainder.total, unit: sample.remainder.unit };
  sample.remainder.total = total;
  sample.remainder.unit = unit;
  const entry = {
    id: `COR-${sample.correctionHistory.length + 1}`,
    at,
    reason,
    from,
    to: { total, unit },
    recomputed: [],
    affectedShipped: []
  };
  sample.correctionHistory.push(entry);

  const changeNote = `余料更正：${from.total}${from.unit} → ${total}${unit}（${reason}）`;
  // 余料更正只影响“超出余料”这一项；区间重叠、编号重复与余料数量无关，不参与重算
  const exceedsNow = (split) => {
    const usedByOthers = sample.splits.reduce(
      (sum, sp) => sum + (sp === split ? 0 : sp.quantity || 0),
      0
    );
    return usedByOthers + split.quantity > total;
  };
  const withExceeds = (conflicts, flag) => {
    const rest = conflicts.filter((c) => c !== CONFLICT.EXCEEDS);
    return flag ? [...rest, CONFLICT.EXCEEDS] : rest;
  };

  for (const split of sample.splits) {
    if (split.status === SPLIT_SHIPPED) {
      // 已外送：旧档冻结不动，只比较“超出余料”判定，变化时标出受影响
      const exceededBefore = split.conflicts.includes(CONFLICT.EXCEEDS);
      const exceedsAfter = exceedsNow(split);
      if (exceededBefore !== exceedsAfter) {
        split.affectedByCorrection = true;
        split.affectedInfo = {
          correctionId: entry.id,
          at,
          reason,
          archivedConflicts: [...split.conflicts],
          currentConflicts: withExceeds(split.conflicts, exceedsAfter)
        };
        entry.affectedShipped.push(split.id);
      }
      continue;
    }
    // 未外送：重算超出余料标记，其余冲突（重叠/重号）原样保留
    const expected = withExceeds(split.conflicts, exceedsNow(split));
    if (!sameSet(expected, split.conflicts)) {
      split.conflictHistory.push({ at, reason: changeNote, from: [...split.conflicts], to: expected });
      if (expected.includes(CONFLICT.EXCEEDS)) split.needsAttention = true;
      split.conflicts = expected;
      entry.recomputed.push(split.id);
    }
  }
  return { sample, correction: entry };
}

/* ---------------- 分样：登记与冲突核验 ---------------- */

function validateSplitInput(input, sample) {
  const id = (input.id || "").trim();
  if (!id) throw new LedgerError("invalidSplitId", "分样编号不能为空");

  const from = num(input.depthFrom);
  const to = num(input.depthTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new LedgerError("invalidDepthRange", "深度区间必须为起始深度 < 结束深度的两个数字（米）");
  }

  const quantity = num(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new LedgerError("invalidQuantity", "分样数量必须为大于 0 的数字");
  }

  const purpose = (input.purpose || "").trim();
  if (!purpose) throw new LedgerError("purposeRequired", "分样用途必须填写");

  if (!sample.remainder) {
    throw new LedgerError("remainderRequired", "母样尚未登记余料，请先登记余料再分样");
  }
  const unit = (input.unit || sample.remainder.unit).trim();
  if (!UNITS.includes(unit) || unit !== sample.remainder.unit) {
    throw new LedgerError("unitMismatch", `分样单位必须与母样余料一致（${sample.remainder.unit}）`);
  }
  return { id, from, to, quantity, unit, purpose };
}

/**
 * 核验分样冲突（不改数据）：
 *  - 与同母样其他分样深度区间重叠
 *  - 全台账编号重复
 *  - 累计分样数量超出母样余料
 * 候选分样本身已在 sample.splits 中，仅按对象身份排除自身。
 */
export function evaluateConflicts(sample, candidate, options = {}) {
  const allSamples = options.allSamples || [sample];
  const conflicts = [];

  const overlap = sample.splits.some(
    (other) => other !== candidate && intervalsOverlap(candidate.interval, other.interval)
  );
  if (overlap) conflicts.push(CONFLICT.OVERLAP);

  const duplicate = allSamples.some((s) =>
    s.splits.some((sp) => sp !== candidate && sp.id === candidate.id)
  );
  if (duplicate) conflicts.push(CONFLICT.DUPLICATE);

  if (sample.remainder) {
    const usedByOthers = sample.splits.reduce(
      (sum, sp) => sum + (sp === candidate ? 0 : sp.quantity || 0),
      0
    );
    if (usedByOthers + candidate.quantity > sample.remainder.total) {
      conflicts.push(CONFLICT.EXCEEDS);
    }
  }
  return conflicts;
}

function newSplitUid(sample, at) {
  const stamp = String(at).slice(0, 19).replace(/[:.]/g, "-");
  return `SP-${stamp}-${sample.splits.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 登记分样：冲突时不拒绝、不改旧记录，新记录照常保留并写明冲突 */
export function addSplit(sample, input, at, allSamples = [sample]) {
  normalizeSample(sample);
  const fields = validateSplitInput(input, sample);
  const split = {
    uid: newSplitUid(sample, at),
    id: fields.id,
    interval: { from: fields.from, to: fields.to },
    depth: `${fields.from}-${fields.to}m`,
    quantity: fields.quantity,
    unit: fields.unit,
    purpose: fields.purpose,
    status: SPLIT_PENDING,
    frozen: false,
    shippedAt: null,
    receipt: null,
    conclusion: "",
    lateReceipts: [],
    conflicts: [],
    conflictHistory: [],
    needsAttention: false,
    affectedByCorrection: false,
    createdAt: at
  };
  split.conflicts = evaluateConflicts(sample, split, { allSamples });
  split.conflictNote = split.conflicts.length
    ? `登记时检出冲突：${conflictText(split.conflicts)}；原记录已保留`
    : "登记时核验通过";
  split.conflictHistory.push({ at, reason: "分样登记核验", from: [], to: [...split.conflicts] });
  sample.splits.push(split);
  return split;
}

/* ---------------- 外送与回执 ---------------- */

/** 外送后冻结该分样 */
export function shipSplit(sample, splitId, at) {
  const split = findSplit(sample, splitId);
  if (split.status === SPLIT_SHIPPED) {
    throw new LedgerError("alreadyShipped", `分样 ${splitId} 已外送并冻结，不能重复外送`);
  }
  split.status = SPLIT_SHIPPED;
  split.frozen = true;
  split.shippedAt = at;
  return split;
}

function normalizeItems(items) {
  const list = Array.isArray(items) ? items : typeof items === "string" ? items.split(/[,，;；]/) : [];
  const cleaned = list.map((x) => String(x).trim()).filter(Boolean);
  if (!cleaned.length) {
    throw new LedgerError("receiptItemsRequired", "回执必须填写检测项目");
  }
  return cleaned;
}

/**
 * 回执：首份回执写明检测项目与结论并归档；
 * 已归档后到达的迟到回执只能附注，不能改掉已归档结论。
 */
export function submitReceipt(sample, splitId, input = {}, at) {
  const split = findSplit(sample, splitId);
  if (split.status !== SPLIT_SHIPPED) {
    throw new LedgerError("notShipped", `分样 ${splitId} 尚未外送，不能登记回执`);
  }
  const items = normalizeItems(input.items);
  const conclusion = (input.conclusion || "").trim();
  if (!conclusion) throw new LedgerError("conclusionRequired", "回执必须填写检测结论");

  if (split.receipt && split.receipt.archived) {
    split.lateReceipts.push({
      items,
      conclusion,
      testedAt: (input.testedAt || "").trim(),
      receivedAt: at,
      note: "迟到回执：仅附注留存，不改变已归档结论"
    });
    return { split, archived: false };
  }

  split.receipt = {
    items,
    conclusion,
    testedAt: (input.testedAt || "").trim(),
    receivedAt: at,
    archived: true,
    archivedAt: at
  };
  split.conclusion = conclusion;
  return { split, archived: true };
}
