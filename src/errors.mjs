// 领域错误：携带 HTTP 状态码，供 HTTP 层统一序列化。
export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new DomainError(400, "bad_request", message, details);
export const notFound = (message, details) => new DomainError(404, "not_found", message, details);
export const conflict = (message, details) => new DomainError(409, "conflict", message, details);
export const unprocessable = (message, details) => new DomainError(422, "unprocessable", message, details);
