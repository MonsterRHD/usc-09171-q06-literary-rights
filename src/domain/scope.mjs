// 最小权利单元（scope）匹配。
// 铁律：缺失维度不代表无限授权。
// - media / territories / channels：必须显式列出且命中，空数组或缺失 = 未授权该维度；
// - max_quantity：字段必须存在，null 表示显式不限量；字段缺失 = 数量维度未授权；
// - exclusive：缺失按 false 处理（排他性只可能限制他人，缺失不会扩大自身权利）。

export const DIMENSION_REASONS = {
  media: "MEDIA_NOT_LICENSED",
  territories: "TERRITORY_NOT_LICENSED",
  channels: "CHANNEL_NOT_LICENSED",
};

export function normalizeScope(input = {}) {
  return {
    media: Array.isArray(input.media) ? [...input.media] : [],
    territories: Array.isArray(input.territories) ? [...input.territories] : [],
    channels: Array.isArray(input.channels) ? [...input.channels] : [],
    max_quantity: Object.hasOwn(input, "max_quantity") ? input.max_quantity : undefined,
    sublicense: input.sublicense === true,
    exclusive: input.exclusive === true,
  };
}

export function validateScope(scope) {
  const errors = [];
  if (scope.media.length === 0) errors.push("scope.media 必须显式列出至少一种媒介");
  if (scope.territories.length === 0) errors.push("scope.territories 必须显式列出至少一个地区");
  if (scope.channels.length === 0) errors.push("scope.channels 必须显式列出至少一个渠道");
  if (scope.max_quantity === undefined) {
    errors.push("scope.max_quantity 必须显式给出（数字或 null=不限量），缺失不等于不限量");
  } else if (scope.max_quantity !== null && (!Number.isInteger(scope.max_quantity) || scope.max_quantity < 0)) {
    errors.push("scope.max_quantity 必须为非负整数或 null");
  }
  return errors;
}

// 结构性维度匹配（不含数量余额，余额在凭证层累计核算）
export function dimensionGaps(scope, req) {
  const gaps = [];
  if (!scope.media.includes(req.media)) gaps.push(DIMENSION_REASONS.media);
  if (!scope.territories.includes(req.territory)) gaps.push(DIMENSION_REASONS.territories);
  if (!scope.channels.includes(req.channel)) gaps.push(DIMENSION_REASONS.channels);
  if (scope.max_quantity === undefined) gaps.push("QUANTITY_NOT_LICENSED");
  return gaps;
}

// 两个显式 scope 的严格交集，用于裁剪凭证范围
export function intersectScopes(a, b) {
  const maxQ = [a.max_quantity, b.max_quantity].includes(null)
    ? (a.max_quantity === null ? b.max_quantity : a.max_quantity)
    : Math.min(a.max_quantity, b.max_quantity);
  return normalizeScope({
    media: a.media.filter((m) => b.media.includes(m)),
    territories: a.territories.filter((t) => b.territories.includes(t)),
    channels: a.channels.filter((c) => b.channels.includes(c)),
    max_quantity: maxQ,
    sublicense: a.sublicense && b.sublicense,
    exclusive: a.exclusive && b.exclusive,
  });
}

export function scopeContains(scope, req) {
  return dimensionGaps(scope, req).length === 0;
}
