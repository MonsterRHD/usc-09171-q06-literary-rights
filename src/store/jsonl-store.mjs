import fs from "node:fs";
import path from "node:path";

// 只追加 JSONL 事件日志。顺序追加、整体读回放；写操作由 service 层串行化。
export class JsonlEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
  }

  load() {
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) return [];
    const events = [];
    raw.split("\n").forEach((line, i) => {
      try {
        events.push(JSON.parse(line));
      } catch (cause) {
        throw new Error(`事件日志第 ${i + 1} 行损坏，拒绝启动: ${cause.message}`);
      }
    });
    return events;
  }

  append(envelopes) {
    const line = envelopes.map((e) => JSON.stringify(e)).join("\n");
    fs.appendFileSync(this.filePath, line + "\n");
  }
}
