import crypto from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

// 规范化 JSON 哈希，用于方案内容指纹与判断问题键
export function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
