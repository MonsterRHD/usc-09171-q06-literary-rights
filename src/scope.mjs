// 最小权利单元的公共判断逻辑。
//
// 仓库约定（适用于权利来源、合同授予、合作方案与每一次使用）：
// 1. 有效期一律为闭开区间 [valid_from, valid_to)：valid_from 当天可用，valid_to 当天起不可用。
// 2. 缺失的维度不代表无限授权：未写明的媒介、地区、渠道、数量、再许可，一律视为未授予。

import { badRequest } from "./errors.mjs";

// 归一化为 UTC ISO 字符串，之后所有时间比较都只是字符串比较。
export function normalizeTime(value, field = "time") {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`字段 ${field} 必须是 ISO 时间字符串`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`字段 ${field} 不是可解析的时间：${value}`);
  }
  return parsed.toISOString();
}

// 闭开区间判断：from <= at < to。
export function withinTerm(validFrom, validTo, at) {
  return validFrom <= at && at < validTo;
}

// 闭开区间相交：首尾相接（a.to === b.from）不算相交。
export function windowsOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

function listOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return [];
  return a.filter((item) => b.includes(item));
}

// 判断一项授权是否覆盖一次使用请求。
// request 中未出现的维度不检查（由调用方决定哪些维度必须声明）；
// grant 中缺失的维度一律视为未授予。返回不满足的原因列表，空数组表示覆盖。
export function coverageGaps(grant, request) {
  const gaps = [];
  if (request.at !== undefined && !withinTerm(grant.valid_from, grant.valid_to, request.at)) {
    gaps.push(`期限未覆盖：授权窗口 [${grant.valid_from}, ${grant.valid_to}) 不含 ${request.at}`);
  }
  if (request.media !== undefined && !(Array.isArray(grant.media) && grant.media.includes(request.media))) {
    gaps.push(`媒介未授予：${request.media}`);
  }
  if (request.territory !== undefined && !(Array.isArray(grant.territories) && grant.territories.includes(request.territory))) {
    gaps.push(`地区未授予：${request.territory}`);
  }
  if (request.channel !== undefined && !(Array.isArray(grant.channels) && grant.channels.includes(request.channel))) {
    gaps.push(`渠道未授予：${request.channel}`);
  }
  if (request.sublicense === true && grant["sublicense"] !== true) {
    gaps.push("再许可未授予");
  }
  if (request.quantity !== undefined) {
    if (typeof grant.quantity !== "number") {
      gaps.push("数量维度未授予");
    } else if (request.quantity > grant.quantity) {
      gaps.push(`数量不足：授予 ${grant.quantity}，请求 ${request.quantity}`);
    }
  }
  return gaps;
}

// 独家窗口冲突：两个范围在媒介、地区、渠道上都有交集且时间窗相交才算冲突。
// 任一维度缺失或不相交都视为不冲突（缺失维度不代表无限授权）。
export function scopeOverlap(a, b) {
  if (!windowsOverlap(a.valid_from, a.valid_to, b.valid_from, b.valid_to)) return null;
  const media = listOverlap(a.media, b.media);
  const territories = listOverlap(a.territories, b.territories);
  const channels = listOverlap(a.channels, b.channels);
  if (media.length === 0 || territories.length === 0 || channels.length === 0) return null;
  return {
    media,
    territories,
    channels,
    window: {
      from: a.valid_from > b.valid_from ? a.valid_from : b.valid_from,
      to: a.valid_to < b.valid_to ? a.valid_to : b.valid_to,
    },
  };
}
