import http from "node:http";
import { RightsService } from "./domain/service.mjs";
import { JsonlEventStore } from "./store/jsonl-store.mjs";
import { DomainError } from "./domain/errors.mjs";

// 路由表：[method, pattern, handlerKey]
const ROUTES = [
  ["GET", /^\/health$/, "health"],
  ["POST", /^\/v1\/assets$/, "registerAsset"],
  ["POST", /^\/v1\/grants$/, "recordGrant"],
  ["POST", /^\/v1\/proposals\/exclusivity-check$/, "checkExclusivity"],
  ["POST", /^\/v1\/proposals$/, "submitProposal"],
  ["POST", /^\/v1\/contracts$/, "createContract"],
  ["POST", /^\/v1\/contracts\/([^/]+)\/versions$/, "addContractVersion"],
  ["POST", /^\/v1\/approvals$/, "recordApproval"],
  ["POST", /^\/v1\/certificates\/issue$/, "issueCertificate"],
  ["POST", /^\/v1\/certificates\/([^/]+)\/revoke$/, "revokeCertificate"],
  ["POST", /^\/v1\/certificates\/([^/]+)\/supplements$/, "recordSupplement"],
  ["GET", /^\/v1\/certificates\/([^/]+)$/, "getCertificate"],
  ["POST", /^\/v1\/material-pickups$/, "pickupMaterial"],
  ["POST", /^\/v1\/samples$/, "recordSample"],
  ["POST", /^\/v1\/usages$/, "recordUsage"],
  ["POST", /^\/v1\/sales$/, "recordSale"],
  ["GET", /^\/v1\/evaluate$/, "evaluate"],
  ["GET", /^\/v1\/decisions$/, "decisionHistory"],
  ["POST", /^\/v1\/settlements\/confirm$/, "confirmSettlement"],
  ["POST", /^\/v1\/settlements\/correct$/, "correctSettlement"],
];

export function createServer(service = defaultService()) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const route = ROUTES.find(([method, pattern]) => request.method === method && pattern.test(url.pathname));
      if (!route) return send(response, 404, { error: "NOT_FOUND", message: `无此端点: ${request.method} ${url.pathname}` });

      const [, pattern, key] = route;
      const match = url.pathname.match(pattern);
      const params = { path: match.slice(1) };
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === "POST" ? await readJson(request) : {};
      const idempotencyKey = request.headers["idempotency-key"] ?? null;

      const result = await handle(service, key, { body, query, params, idempotencyKey });
      const status = key === "checkExclusivity" || key === "evaluate" || key === "decisionHistory" || key === "getCertificate" || key === "health"
        ? 200 : 201;
      return send(response, status, result);
    } catch (error) {
      return sendError(response, error);
    }
  });
  server.service = service;
  return server;
}

async function handle(service, key, ctx) {
  switch (key) {
    case "health":
      return { status: "ok", service: "literary-rights" };
    case "getCertificate": {
      const cert = service.getState().certificates.get(ctx.params.path[0]);
      if (!cert) throw new DomainError("NOT_FOUND", `凭证不存在: ${ctx.params.path[0]}`);
      return cert;
    }
    case "evaluate":
      return service.evaluate(ctx.query);
    case "decisionHistory":
      return service.decisionHistory(ctx.query);
    case "checkExclusivity":
      return service.checkExclusivity(withKey(ctx));
    case "revokeCertificate":
      return unwrap(service.revokeCertificate({ ...withKey(ctx), cert_id: ctx.params.path[0] }));
    case "recordSupplement":
      return unwrap(service.recordSupplement({ ...withKey(ctx), cert_id: ctx.params.path[0] }));
    case "addContractVersion":
      return unwrap(service.addContractVersion({ ...withKey(ctx), contract_id: ctx.params.path[0] }));
    default:
      return unwrap(service[key](withKey(ctx)));
  }
}

function withKey(ctx) {
  return ctx.idempotencyKey ? { ...ctx.body, idempotency_key: ctx.idempotencyKey } : ctx.body;
}

// 写命令返回 {duplicate, events} 时，提炼出业务主键；重复提交返回 200 而非新建
async function unwrap(promise) {
  const r = await promise;
  if (r.duplicate) return { duplicate: true, ...r };
  const first = r.events[0];
  return { duplicate: false, event_id: first.event_id, type: first.type, ...first.payload };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (cause) { reject(new DomainError("INVALID", `请求体不是合法 JSON: ${cause.message}`)); }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, replacer));
}

function sendError(response, error) {
  const status = {
    CONFLICT: 409,
    NOT_FOUND: 404,
    INVALID: 400,
  }[error.code] ?? 500;
  if (status === 500) console.error(error);
  send(response, status, { error: error.code ?? "INTERNAL", message: error.message, details: error.details ?? undefined });
}

// Map/Set 序列化
function replacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

let defaultSvc;
function defaultService() {
  if (!defaultSvc) {
    const file = process.env.EVENTS_FILE ?? "data/events.jsonl";
    defaultSvc = new RightsService(new JsonlEventStore(file));
  }
  return defaultSvc;
}
