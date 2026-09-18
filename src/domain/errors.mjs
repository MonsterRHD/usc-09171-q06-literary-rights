export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function conflict(message, details = {}) {
  return new DomainError("CONFLICT", message, details);
}

export function notFound(message, details = {}) {
  return new DomainError("NOT_FOUND", message, details);
}

export function invalid(message, details = {}) {
  return new DomainError("INVALID", message, details);
}
