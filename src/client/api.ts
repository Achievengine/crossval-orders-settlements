export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly maxAllowedCents?: number;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    maxAllowedCents?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.maxAllowedCents = maxAllowedCents;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const payload = (await response.json()) as
    | { data: T }
    | { error: { code: string; message: string; details?: Record<string, unknown>; max_allowed_cents?: number } };

  if (!response.ok || "error" in payload) {
    const error = "error" in payload
      ? payload.error
      : { code: "REQUEST_FAILED", message: "The request could not be completed." };
    throw new ApiError(error.code, error.message, error.details, error.max_allowed_cents);
  }

  return payload.data;
}