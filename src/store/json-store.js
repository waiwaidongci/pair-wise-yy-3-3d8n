// 保存层：台账 JSON 的读写与原子落盘，不承载业务核验。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export function createJsonStore(filePath) {
  async function load() {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  }

  /** 先写临时文件再 rename，避免半写入数据污染台账 */
  async function save(data) {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, filePath);
  }

  async function ensure(seed) {
    if (!existsSync(filePath)) {
      await mkdir(dirname(filePath), { recursive: true });
      await save(seed);
    }
  }

  return { load, save, ensure };
}
