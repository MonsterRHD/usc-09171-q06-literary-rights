// 持久层：单一状态文件 + 串行化写入。
//
// 所有写操作经 Store.mutate 排入队列依次执行，落盘（临时文件 + 原子改名）成功后才返回，
// 因此并发请求不会交错写坏状态，服务重启后也能从同一文件恢复——
// 这是「并发提交与服务重启都不得制造第二张有效凭证」的底层保证。

import { promises as fs } from "node:fs";
import path from "node:path";

const emptyState = () => ({
  assets: {},
  rights_sources: {},
  proposals: {},
  contracts: {},
  credentials: {},
  judgments: [], // 只追加，不修改
  usages: [], // 只追加，不修改
  settlements: {},
  corrections: [], // 只追加，不修改
  sequences: {},
});

export class Store {
  #filePath;
  #queue = Promise.resolve();

  constructor(filePath, state) {
    this.#filePath = filePath;
    this.state = state;
  }

  static async open(filePath) {
    if (filePath == null) return new Store(null, emptyState());
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return new Store(filePath, { ...emptyState(), ...JSON.parse(raw) });
    } catch (error) {
      if (error.code === "ENOENT") return new Store(filePath, emptyState());
      throw error;
    }
  }

  // 串行执行 fn(state)，成功后持久化。fn 必须是同步函数。
  async mutate(fn) {
    const task = this.#queue.then(async () => {
      const result = fn(this.state);
      await this.#persist();
      return result;
    });
    // 上一次失败不阻塞后续写入。
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #persist() {
    if (this.#filePath == null) return;
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.#filePath);
  }
}

// 单调递增的序列号，随状态一起持久化，重启后不会重号。
export function nextId(state, prefix) {
  const n = (state.sequences[prefix] ?? 0) + 1;
  state.sequences[prefix] = n;
  return `${prefix}-${String(n).padStart(4, "0")}`;
}
