// 闭开区间 [valid_from, valid_to) 与日期工具。
// 所有日期均为 YYYY-MM-DD 字符串，可直接按字典序比较；valid_to 为 null 表示显式无固定期限。

export function toDay(value) {
  if (value === null || value === undefined) return null;
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`非法日期: ${value}`);
  }
  return day;
}

export function isValidRange(from, to) {
  if (!from) return false;
  if (to === null || to === undefined) return true;
  return to > from;
}

// 某一天是否落在闭开区间内：from <= day < to
export function coversDay(day, from, to) {
  const d = toDay(day);
  if (d < toDay(from)) return false;
  if (to !== null && to !== undefined && d >= toDay(to)) return false;
  return true;
}

// 两个闭开区间是否有交集（用于独家窗口冲突检查）
export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  if (aFrom >= (bTo ?? "9999-12-31")) return false;
  if (bFrom >= (aTo ?? "9999-12-31")) return false;
  return true;
}

export function monthOf(day) {
  return toDay(day).slice(0, 7);
}

export function lastDayOfMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
