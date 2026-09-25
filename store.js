import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dbPath = join(__dirname, "data", "core-slices.json");

// 仅在首次运行（数据文件不存在）时使用的演示数据
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
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
          ]
        }
      ],
      remainder: { quantity: 0.32, unit: "m", updatedAt: "2026-06-14T09:00:00.000Z" },
      remainderHistory: [
        { at: "2026-06-14T09:00:00.000Z", quantity: 0.32, unit: "m", reason: "母样登记余料" }
      ],
      conflictLog: [],
      splits: [
        {
          id: "SP-001-1",
          depthFrom: 128.42,
          depthTo: 128.46,
          quantity: 0.04,
          unit: "m",
          purpose: "外送光片鉴定",
          createdAt: "2026-06-14T09:20:00.000Z",
          status: "在库",
          frozen: false,
          conflicts: [],
          balanceAfter: 0.28,
          dispatch: null,
          remainderSnapshot: null,
          archivedReceipt: null,
          receipts: [],
          affected: false,
          affectedByCorrections: []
        }
      ]
    }
  ]
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 串行化读改写：同一时刻只有一个写事务在操作数据文件
let tail = Promise.resolve();
export function transaction(worker) {
  const run = tail.then(async () => {
    const db = await loadDb();
    const result = await worker(db);
    await saveDb(db);
    return result;
  });
  // 前一笔失败不能阻塞后续事务
  tail = run.then(
    () => {},
    () => {}
  );
  return run;
}
