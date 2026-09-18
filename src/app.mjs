import http from "node:http";
import { readFile } from "node:fs/promises";
import { DomainError, badRequest, notFound } from "./errors.mjs";
import * as engine from "./engine.mjs";
import { Store } from "./store.mjs";

const DEFAULT_SEED_FILE = new URL("../contracts/rights-source.json", import.meta.url);

export function createServer(options = {}) {
  const store = options.store ?? null;
  const now = options.now ?? (() => new Date().toISOString());
  return http.createServer((request, response) => {
    dispatch(request, response, { store, now }).catch((error) => sendError(response, error));
  });
}

// 完整启动：打开状态文件，幂等装载仓库自带的权利来源样例。
export async function createApp(options = {}) {
  const store = options.store ?? (await Store.open(options.storePath ?? "data/state.json"));
  const seedFile = options.seedFile === undefined ? DEFAULT_SEED_FILE : options.seedFile;
  if (seedFile !== null) {
    const seeds = JSON.parse(await readFile(seedFile, "utf8"));
    const now = options.now ?? (() => new Date().toISOString());
    await store.mutate((state) => {
      for (const seed of seeds) {
        if (!state.rights_sources[seed.source_id]) {
          engine.addRightsSource(state, seed, { now });
        }
      }
    });
  }
  return createServer({ ...options, store });
}

function buildRoutes({ store, now }) {
  const state = () => {
    if (!store) throw new DomainError(503, "store_unavailable", "存储未初始化");
    return store.state;
  };
  const mutate = (fn) => {
    if (!store) throw new DomainError(503, "store_unavailable", "存储未初始化");
    return store.mutate((current) => fn(current, { now }));
  };
  const ok = (body, status = 200) => ({ status, body });
  return [
    ["GET", ["health"], async () => ok({ status: "ok", service: "literary-rights" })],

    // 素材与来源关系
    ["POST", ["assets"], async ({ body }) => ok(await mutate((s, c) => engine.registerAsset(s, body, c)), 201)],
    ["GET", ["assets"], async () => ok(Object.values(state().assets))],
    ["GET", ["assets", ":ref"], async ({ params }) => ok(engine.assetView(state(), params.ref))],

    // 权利来源声明
    ["POST", ["rights-sources"], async ({ body }) => ok(await mutate((s, c) => engine.addRightsSource(s, body, c)), 201)],
    [
      "GET",
      ["rights-sources"],
      async ({ query }) =>
        ok(Object.values(state().rights_sources).filter((s) => !query.get("asset_ref") || s.asset_ref === query.get("asset_ref"))),
    ],

    // 合作方案（响应内含独家窗口冲突，签约前可见）
    ["POST", ["proposals"], async ({ body }) => ok(await mutate((s, c) => engine.submitProposal(s, body, c)), 201)],
    ["GET", ["proposals", ":id"], async ({ params }) => ok(engine.getProposal(state(), params.id))],
    [
      "GET",
      ["proposals", ":id", "conflicts"],
      async ({ params }) => ok({ conflicts: engine.findWindowConflicts(state(), engine.getProposal(state(), params.id)) }),
    ],

    // 合同、版本与审批链
    ["POST", ["contracts"], async ({ body }) => ok(await mutate((s, c) => engine.createContract(s, body, c)), 201)],
    ["GET", ["contracts", ":id"], async ({ params }) => ok(engine.contractView(state(), params.id))],
    ["POST", ["contracts", ":id", "versions"], async ({ params, body }) => ok(await mutate((s, c) => engine.addContractVersion(s, params.id, body, c)), 201)],
    [
      "POST",
      ["contracts", ":id", "versions", ":n", "approvals"],
      async ({ params, body }) =>
        ok(await mutate((s, c) => engine.approve(s, { ...body, contract_id: params.id, version: Number(params.n) }, c)), 201),
    ],

    // 范围凭证（同一方案至多一张有效凭证，签发幂等）
    [
      "POST",
      ["credentials"],
      async ({ body }) => {
        const result = await mutate((s, c) => engine.issueCredential(s, body, c));
        return ok(result, result.created ? 201 : 200);
      },
    ],
    [
      "GET",
      ["credentials"],
      async ({ query }) =>
        ok(
          Object.values(state().credentials).filter(
            (credential) =>
              (!query.get("proposal_id") || credential.proposal_id === query.get("proposal_id")) &&
              (!query.get("licensee_ref") || credential.licensee_ref === query.get("licensee_ref")) &&
              (!query.get("status") || credential.status === query.get("status")),
          ),
        ),
    ],
    ["GET", ["credentials", ":id"], async ({ params }) => ok(engine.getCredential(state(), params.id))],
    [
      "POST",
      ["credentials", ":id", "revoke"],
      async ({ params, body }) => ok(await mutate((s, c) => engine.revokeCredential(s, { ...body, credential_id: params.id }, c))),
    ],

    // 判断入口：任意日期查询任一素材的任一使用方式
    ["POST", ["decisions"], async ({ body }) => ok(await mutate((s, c) => engine.evaluate(s, { ...body, kind: "query" }, c)), 201)],
    [
      "GET",
      ["judgments"],
      async ({ query }) =>
        ok(
          engine.listJudgments(state(), {
            asset_ref: query.get("asset_ref") ?? undefined,
            kind: query.get("kind") ?? undefined,
            credential_id: query.get("credential_id") ?? undefined,
          }),
        ),
    ],
    ["GET", ["judgments", ":id"], async ({ params }) => ok(engine.getJudgment(state(), params.id))],

    // 素材领取、样稿、实际使用，都经同一个判断入口
    ["POST", ["material-pickups"], async ({ body }) => ok(await mutate((s, c) => engine.gateClearance(s, { ...body, kind: "material-pickup" }, c)), 201)],
    ["POST", ["sample-drafts"], async ({ body }) => ok(await mutate((s, c) => engine.gateClearance(s, { ...body, kind: "sample-draft" }, c)), 201)],
    ["POST", ["usages"], async ({ body }) => ok(await mutate((s, c) => engine.recordUsage(s, body, c)), 201)],
    [
      "GET",
      ["usages"],
      async ({ query }) => ok(state().usages.filter((u) => !query.get("credential_id") || u.credential_id === query.get("credential_id"))),
    ],

    // 跨月结算与可追溯更正
    [
      "POST",
      ["settlements", "run"],
      async ({ body }) => {
        const result = await mutate((s, c) => engine.runSettlement(s, body, c));
        return ok(result, result.created ? 201 : 200);
      },
    ],
    ["GET", ["settlements", ":id"], async ({ params }) => ok(engine.settlementView(state(), params.id))],
    ["POST", ["settlements", ":id", "confirm"], async ({ params }) => ok(await mutate((s, c) => engine.confirmSettlement(s, params.id, c)))],
    [
      "POST",
      ["settlements", ":id", "corrections"],
      async ({ params, body }) => ok(await mutate((s, c) => engine.correctSettlement(s, params.id, body, c)), 201),
    ],
  ];
}

function matchPattern(segments, pattern) {
  if (segments.length !== pattern.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i];
    if (part.startsWith(":")) params[part.slice(1)] = segments[i];
    else if (part !== segments[i]) return null;
  }
  return params;
}

async function dispatch(request, response, ctx) {
  const url = new URL(request.url, "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const routes = buildRoutes(ctx);
  for (const [method, pattern, handler] of routes) {
    if (method !== request.method) continue;
    const params = matchPattern(segments, pattern);
    if (!params) continue;
    const body = await readBody(request);
    const result = await handler({ params, body, query: url.searchParams });
    return sendJson(response, result.status, result.body);
  }
  throw notFound(`路由不存在：${request.method} ${url.pathname}`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  if (response.headersSent) return response.end();
  if (error instanceof DomainError) {
    return sendJson(response, error.status, {
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
  }
  console.error(error);
  sendJson(response, 500, { error: { code: "internal", message: "服务内部错误" } });
}
