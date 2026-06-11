/**
 * Centralized error classification for the content pipeline.
 *
 * Categorizes errors into well-known buckets (network, HTTP, rate-limit,
 * timeout, validation) so callers can react appropriately and monitoring
 * can aggregate by category.
 */

export enum ErrorCategory {
  NETWORK = "network",
  HTTP_CLIENT = "http_4xx",
  HTTP_SERVER = "http_5xx",
  RATE_LIMIT = "rate_limit",
  TIMEOUT = "timeout",
  VALIDATION = "validation",
  UNKNOWN = "unknown",
}

export class ClassifiedError extends Error {
  constructor(
    message: string,
    public readonly category: ErrorCategory,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClassifiedError";
  }
}

/**
 * Classify an arbitrary error into a {@link ClassifiedError}.
 *
 * If the error is already a `ClassifiedError` it is returned as-is.
 * Otherwise the error is inspected (type, message content) to pick the
 * most appropriate {@link ErrorCategory}.
 */
export function classifyError(err: unknown, context?: string): ClassifiedError {
  if (err instanceof ClassifiedError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const prefix = context ? `[${context}] ` : "";

  // Network/fetch failures (TypeError from failed fetch)
  if (err instanceof TypeError) {
    return new ClassifiedError(`${prefix}${message}`, ErrorCategory.NETWORK, undefined, err);
  }

  // Abort/timeout
  if (err instanceof DOMException && err.name === "AbortError") {
    return new ClassifiedError(`${prefix}${message}`, ErrorCategory.TIMEOUT, undefined, err);
  }

  // HTTP status from Notion API errors
  const statusMatch = message.match(/status (\d+)/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status === 429) {
      return new ClassifiedError(`${prefix}${message}`, ErrorCategory.RATE_LIMIT, status, err);
    }
    if (status >= 500) {
      return new ClassifiedError(`${prefix}${message}`, ErrorCategory.HTTP_SERVER, status, err);
    }
    if (status >= 400) {
      return new ClassifiedError(`${prefix}${message}`, ErrorCategory.HTTP_CLIENT, status, err);
    }
  }

  // JSON parse / schema validation
  if (
    message.includes("JSON") ||
    message.includes("parse") ||
    message.includes("schema") ||
    message.includes("validation")
  ) {
    return new ClassifiedError(`${prefix}${message}`, ErrorCategory.VALIDATION, undefined, err);
  }

  return new ClassifiedError(`${prefix}${message}`, ErrorCategory.UNKNOWN, undefined, err);
}
