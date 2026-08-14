export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
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
    | { error: { code: string; message: string; details?: Record<string, unknown> } };

  if (!response.ok || "error" in payload) {
    const error = "error" in payload
      ? payload.error
      : { code: "REQUEST_FAILED", message: "The request could not be completed." };
    throw new ApiError(error.code, error.message, error.details);
  }

  return payload.data;
}