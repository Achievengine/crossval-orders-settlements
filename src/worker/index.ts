import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { ORDER_STATUSES, calculateOrderTotal, deriveOrderStatus } from "../shared/domain";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../shared/password";

type Bindings = Env;
type Variables = { userId: string; requestId: string; requestStartedAt: number };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type OrderRow = {
  id: string;
  customer: string;
  due_date: string;
  total_cents: number;
  amount_paid_cents: number;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  position: number;
};

type PaymentRow = {
  id: string;
  amount_cents: number;
  payment_date: string;
  note: string | null;
  created_at: string;
};

type IdempotencyRow = {
  payload_hash: string;
  response_json: string;
};

type AuditEventRow = {
  id: string;
  event_type: string;
  actor_user_id: string;
  request_id: string;
  metadata_json: string;
  created_at: string;
};

const SESSION_COOKIE = "crossval_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7;
const PBKDF2_ITERATIONS = 100_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const PAYMENT_OPERATION = "payment.create";
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const credentialsSchema = z.object({
  email: z.email().max(254).transform((email) => email.trim().toLowerCase()),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPriceCents: z.number().int().min(1).max(1_000_000_000),
});

const orderSchema = z.object({
  customer: z.string().trim().min(1).max(200),
  dueDate: z.string().regex(ISO_DATE_PATTERN, "Due date must use YYYY-MM-DD format."),
  items: z.array(lineItemSchema).min(1).max(100),
});

const paymentSchema = z.object({
  amountCents: z.number().int().min(1).max(1_000_000_000_000),
  paymentDate: z.string().regex(ISO_DATE_PATTERN, "Payment date must use YYYY-MM-DD format."),
  note: z.string().trim().max(500).optional(),
});

const statusSchema = z.enum(ORDER_STATUSES);

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64(new Uint8Array(digest));
}

function paymentPayloadHashInput(
  orderId: string,
  payment: z.infer<typeof paymentSchema>,
): string {
  return JSON.stringify({
    orderId,
    amountCents: payment.amountCents,
    paymentDate: payment.paymentDate,
    note: payment.note ?? null,
  });
}

async function hashPassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return encodeBase64(new Uint8Array(bits));
}

function secureRandomToken(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function apiError(
  context: AppContext,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500,
  code: string,
  message: string,
  options: {
    field?: string;
    maxAllowedCents?: number;
    retryable?: boolean;
    details?: unknown;
    retryAfterSeconds?: number;
  } = {},
) {
  if (options.retryAfterSeconds !== undefined) {
    context.header("Retry-After", String(options.retryAfterSeconds));
  }
  return context.json({
    error: {
      code,
      message,
      ...(options.field === undefined ? {} : { field: options.field }),
      ...(options.maxAllowedCents === undefined
        ? {}
        : { max_allowed_cents: options.maxAllowedCents }),
      request_id: context.get("requestId"),
      retryable: options.retryable ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  }, status);
}

async function parseBody(context: AppContext): Promise<unknown> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) {
    throw new ApiFailure(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new ApiFailure(413, "REQUEST_TOO_LARGE", "Request body exceeds the 32 KiB limit.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new ApiFailure(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

class ApiFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429,
    readonly code: string,
    message: string,
    readonly options: Parameters<typeof apiError>[4] = {},
  ) {
    super(message);
  }
}

async function consumeRateLimit(
  context: AppContext,
  action: string,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartedAt = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const scopeHash = await sha256(scope);
  const result = await context.env.DB.prepare(
    `INSERT INTO rate_limits (scope_hash, action, window_started_at, request_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(scope_hash, action, window_started_at)
     DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  )
    .bind(scopeHash, action, windowStartedAt)
    .first<{ request_count: number }>();
  if ((result?.request_count ?? 1) <= limit) {
    return null;
  }
  const retryAfterSeconds = windowStartedAt + windowSeconds - nowSeconds;
  return apiError(context, 429, "RATE_LIMITED", "Too many requests. Try again later.", {
    retryable: true,
    retryAfterSeconds,
  });
}

function formatOrder(row: OrderRow, today = new Date().toISOString().slice(0, 10)) {
  const amountDueCents = Math.max(row.total_cents - row.amount_paid_cents, 0);
  return {
    id: row.id,
    orderNumber: `ORD-${row.id.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    customer: row.customer,
    dueDate: row.due_date,
    totalCents: row.total_cents,
    amountPaidCents: row.amount_paid_cents,
    amountDueCents,
    status: deriveOrderStatus(row.total_cents, row.amount_paid_cents, row.due_date, today),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatItem(row: ItemRow) {
  return {
    id: row.id,
    description: row.description,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    position: row.position,
  };
}

function formatPayment(row: PaymentRow) {
  return {
    id: row.id,
    reference: `PAY-${row.id.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    amountCents: row.amount_cents,
    paymentDate: row.payment_date,
    note: row.note,
    createdAt: row.created_at,
  };
}

function escapeCsvValue(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function formatAuditEvent(row: AuditEventRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    requestId: row.request_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function auditStatement(
  context: { env: Bindings; get: (key: "userId" | "requestId") => string },
  orderId: string,
  eventType: string,
  metadata: Record<string, unknown>,
) {
  const userId = context.get("userId");
  return context.env.DB.prepare(
    `INSERT INTO audit_events
      (id, user_id, order_id, event_type, actor_user_id, request_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    userId,
    orderId,
    eventType,
    userId,
    context.get("requestId"),
    JSON.stringify(metadata),
  );
}

async function createSessionData(): Promise<{ token: string; tokenHash: string; expiresAt: string }> {
  const token = secureRandomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  return { token, tokenHash, expiresAt };
}

async function issueSession(context: { env: Bindings }, userId: string): Promise<string> {
  const session = await createSessionData();
  await context.env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(session.tokenHash, userId, session.expiresAt)
    .run();
  return session.token;
}

function setSessionCookie(context: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

app.use("*", async (context, next) => {
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
  context.set("requestId", requestId);
  context.set("requestStartedAt", Date.now());
  await next();
  const headers = new Headers(context.res.headers);
  headers.set("X-Request-Id", requestId);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  context.res = new Response(context.res.body, {
    status: context.res.status,
    statusText: context.res.statusText,
    headers,
  });
  console.log(JSON.stringify({
    event: "request_completed",
    requestId,
    method: context.req.method,
    route: context.req.path,
    status: context.res.status,
    durationMs: Date.now() - context.get("requestStartedAt"),
    userId: context.get("userId") || undefined,
    orderId: context.req.path.match(/^\/api\/orders\/([0-9a-f-]{36})(?:\/|$)/)?.[1],
  }));
});

app.use("/api/*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  if (WRITE_METHODS.has(context.req.method)) {
    const contentType = context.req.header("Content-Type")?.split(";", 1)[0].trim();
    const contentLength = Number(context.req.header("Content-Length") ?? 0);
    const hasBody = contentLength > 0 || context.req.header("Transfer-Encoding") !== undefined;
    if ((hasBody || contentType !== undefined) && contentType !== "application/json") {
      return apiError(context, 415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json.");
    }
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return apiError(context, 413, "REQUEST_TOO_LARGE", "Request body exceeds the 32 KiB limit.");
    }
    const origin = context.req.header("Origin");
    if (origin && origin !== new URL(context.req.url).origin) {
      return apiError(context, 403, "ORIGIN_NOT_ALLOWED", "Cross-origin writes are not allowed.");
    }
    if (context.req.header("Sec-Fetch-Site") === "cross-site") {
      return apiError(context, 403, "ORIGIN_NOT_ALLOWED", "Cross-origin writes are not allowed.");
    }
  }
  await next();
});

app.get("/api/health", async (context) => {
  const database = await context.env.DB.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
  return context.json({
    data: {
      status: database?.healthy === 1 ? "ok" : "degraded",
      version: context.env.APP_VERSION,
    },
  });
});

app.post("/api/auth/signup", async (context) => {
  const rateLimited = await consumeRateLimit(
    context,
    "auth.signup",
    context.req.header("CF-Connecting-IP") ?? "local",
    10,
    15 * 60,
  );
  if (rateLimited) return rateLimited;
  const parsed = credentialsSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the highlighted fields.", {
      details: parsed.error.flatten(),
    });
  }

  const userId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await hashPassword(parsed.data.password, salt);
  const session = await createSessionData();

  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)",
      ).bind(userId, parsed.data.email, passwordHash, encodeBase64(salt)),
      context.env.DB.prepare(
        "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)",
      ).bind(session.tokenHash, userId, session.expiresAt),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return apiError(context, 409, "EMAIL_ALREADY_EXISTS", "An account with this email already exists. Log in instead.");
    }
    throw error;
  }

  setSessionCookie(context, session.token);
  return context.json({ data: { user: { id: userId, email: parsed.data.email } } }, 201);
});

app.post("/api/auth/login", async (context) => {
  const rateLimited = await consumeRateLimit(
    context,
    "auth.login",
    context.req.header("CF-Connecting-IP") ?? "local",
    10,
    15 * 60,
  );
  if (rateLimited) return rateLimited;
  const parsed = credentialsSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Enter a valid email and password.", {
      details: parsed.error.flatten(),
    });
  }

  const user = await context.env.DB.prepare(
    "SELECT id, email, password_hash, password_salt FROM users WHERE email = ? LIMIT 1",
  )
    .bind(parsed.data.email)
    .first<{ id: string; email: string; password_hash: string; password_salt: string }>();
  const passwordMatches = user
    ? (await hashPassword(parsed.data.password, decodeBase64(user.password_salt))) === user.password_hash
    : false;

  if (!user || !passwordMatches) {
    return apiError(context, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }

  const token = await issueSession(context, user.id);
  setSessionCookie(context, token);
  return context.json({ data: { user: { id: user.id, email: user.email } } });
});

app.use("/api/*", async (context, next) => {
  const publicPaths = new Set(["/api/health", "/api/auth/signup", "/api/auth/login"]);
  if (publicPaths.has(context.req.path)) {
    return next();
  }

  const token = getCookie(context, SESSION_COOKIE);
  if (!token) {
    return apiError(context, 401, "UNAUTHENTICATED", "Log in to continue.");
  }

  const session = await context.env.DB.prepare(
    "SELECT user_id FROM sessions WHERE id_hash = ? AND expires_at > datetime('now') LIMIT 1",
  )
    .bind(await sha256(token))
    .first<{ user_id: string }>();
  if (!session) {
    deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true });
    return apiError(context, 401, "SESSION_EXPIRED", "Your session expired. Log in again.");
  }

  context.set("userId", session.user_id);
  return next();
});

app.post("/api/auth/logout", async (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    await context.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await sha256(token))
      .run();
  }
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true });
  return context.json({ data: { success: true } });
});

app.get("/api/auth/me", async (context) => {
  const user = await context.env.DB.prepare("SELECT id, email FROM users WHERE id = ? LIMIT 1")
    .bind(context.get("userId"))
    .first<{ id: string; email: string }>();
  if (!user) {
    return apiError(context, 401, "UNAUTHENTICATED", "Log in to continue.");
  }
  return context.json({ data: { user } });
});

app.get("/api/orders", async (context) => {
  const statusResult = statusSchema.safeParse(context.req.query("status"));
  const requestedStatus = context.req.query("status") ? statusResult.data : undefined;
  if (context.req.query("status") && !statusResult.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Status filter is not valid.");
  }

  const rows = await context.env.DB.prepare(
    `SELECT o.id, o.customer, o.due_date, o.total_cents, o.created_at, o.updated_at,
      COALESCE(SUM(p.amount_cents), 0) AS amount_paid_cents
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.user_id = ? AND o.deleted_at IS NULL
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
  )
    .bind(context.get("userId"))
    .all<OrderRow>();
  const orders = rows.results.map((row) => formatOrder(row));
  return context.json({ data: { orders: requestedStatus ? orders.filter((order) => order.status === requestedStatus) : orders } });
});

app.get("/api/orders.csv", async (context) => {
  const rows = await context.env.DB.prepare(
    `SELECT o.id, o.customer, o.due_date, o.total_cents, o.created_at, o.updated_at,
      COALESCE(SUM(p.amount_cents), 0) AS amount_paid_cents
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.user_id = ? AND o.deleted_at IS NULL
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
  )
    .bind(context.get("userId"))
    .all<OrderRow>();
  const header = ["order_number", "customer", "status", "total_cents", "paid_cents", "due_cents", "due_date"];
  const lines = rows.results.map((row) => {
    const order = formatOrder(row);
    return [
      order.orderNumber,
      order.customer,
      order.status,
      order.totalCents,
      order.amountPaidCents,
      order.amountDueCents,
      order.dueDate,
    ].map(escapeCsvValue).join(",");
  });
  context.header("Content-Type", "text/csv; charset=utf-8");
  context.header("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  return context.body([header.map(escapeCsvValue).join(","), ...lines].join("\n"));
});

app.post("/api/demo", async (context) => {
  const userId = context.get("userId");
  const orderId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const idempotencyKey = `demo-${crypto.randomUUID()}`;
  const keyHash = await sha256(idempotencyKey);
  const paymentData = {
    amountCents: 40_000,
    paymentDate: new Date().toISOString().slice(0, 10),
    note: "Demo first installment",
  };
  const payloadHash = await sha256(paymentPayloadHashInput(orderId, paymentData));
  const responseBody = { data: { payment: { id: paymentId, amountCents: 40_000 } } };
  const suffix = orderId.replaceAll("-", "").slice(0, 4).toUpperCase();
  const dueDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO orders (id, user_id, customer, due_date, total_cents) VALUES (?, ?, ?, ?, ?)",
    ).bind(orderId, userId, `Demo Company ${suffix}`, dueDate, 100_000),
    context.env.DB.prepare(
      `INSERT INTO order_items
        (id, order_id, description, quantity, unit_price_cents, line_total_cents, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), orderId, "Implementation services", 2, 50_000, 100_000, 0),
    context.env.DB.prepare(
      "INSERT INTO payments (id, order_id, amount_cents, payment_date, note) VALUES (?, ?, ?, ?, ?)",
    ).bind(paymentId, orderId, 40_000, paymentData.paymentDate, paymentData.note),
    context.env.DB.prepare(
      `INSERT INTO idempotency_records
        (user_id, operation, key_hash, payload_hash, payment_id, response_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(userId, PAYMENT_OPERATION, keyHash, payloadHash, paymentId, JSON.stringify(responseBody)),
    auditStatement(context, orderId, "order.created", {
      customer: `Demo Company ${suffix}`,
      totalCents: 100_000,
      dueDate,
      lineItemCount: 1,
      demo: true,
    }),
    auditStatement(context, orderId, "payment.recorded", {
      paymentId,
      amountCents: 40_000,
      paymentDate: paymentData.paymentDate,
    }),
    auditStatement(context, orderId, "order.locked", { paymentId }),
  ]);

  return context.json({ data: { order: { id: orderId, orderNumber: `ORD-${orderId.replaceAll("-", "").slice(0, 8).toUpperCase()}` } } }, 201);
});

app.post("/api/orders", async (context) => {
  const parsed = orderSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the order fields.", {
      details: parsed.error.flatten(),
    });
  }

  const totalCents = calculateOrderTotal(parsed.data.items);
  if (!Number.isSafeInteger(totalCents)) {
    return apiError(context, 422, "INVALID_TOTAL", "The order total is too large.");
  }

  const orderId = crypto.randomUUID();
  const statements = [
    context.env.DB.prepare(
      "INSERT INTO orders (id, user_id, customer, due_date, total_cents) VALUES (?, ?, ?, ?, ?)",
    ).bind(orderId, context.get("userId"), parsed.data.customer, parsed.data.dueDate, totalCents),
    ...parsed.data.items.map((item, position) =>
      context.env.DB.prepare(
        `INSERT INTO order_items
          (id, order_id, description, quantity, unit_price_cents, line_total_cents, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        orderId,
        item.description,
        item.quantity,
        item.unitPriceCents,
        item.quantity * item.unitPriceCents,
        position,
      ),
    ),
    auditStatement(context, orderId, "order.created", {
      customer: parsed.data.customer,
      totalCents,
      dueDate: parsed.data.dueDate,
      lineItemCount: parsed.data.items.length,
    }),
  ];
  await context.env.DB.batch(statements);
  return context.json({ data: { order: { id: orderId, totalCents } } }, 201);
});

app.get("/api/orders/:orderId", async (context) => {
  const order = await context.env.DB.prepare(
    `SELECT o.id, o.customer, o.due_date, o.total_cents, o.created_at, o.updated_at,
      COALESCE(SUM(p.amount_cents), 0) AS amount_paid_cents
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL
     GROUP BY o.id
     LIMIT 1`,
  )
    .bind(context.req.param("orderId"), context.get("userId"))
    .first<OrderRow>();
  if (!order) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }

  const [items, payments, auditEvents] = await Promise.all([
    context.env.DB.prepare(
      `SELECT id, description, quantity, unit_price_cents, line_total_cents, position
       FROM order_items WHERE order_id = ? ORDER BY position`,
    )
      .bind(order.id)
      .all<ItemRow>(),
    context.env.DB.prepare(
      `SELECT id, amount_cents, payment_date, note, created_at
       FROM payments WHERE order_id = ? ORDER BY payment_date DESC, created_at DESC`,
    )
      .bind(order.id)
      .all<PaymentRow>(),
    context.env.DB.prepare(
      `SELECT id, event_type, actor_user_id, request_id, metadata_json, created_at
       FROM audit_events WHERE user_id = ? AND order_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
      .bind(context.get("userId"), order.id)
      .all<AuditEventRow>(),
  ]);
  return context.json({
    data: {
      order: {
        ...formatOrder(order),
        items: items.results.map(formatItem),
        payments: payments.results.map(formatPayment),
        auditEvents: auditEvents.results.map(formatAuditEvent),
        isEditable: payments.results.length === 0,
      },
    },
  });
});

app.put("/api/orders/:orderId", async (context) => {
  const parsed = orderSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the order fields.", {
      details: parsed.error.flatten(),
    });
  }

  const existing = await context.env.DB.prepare(
    `SELECT o.id, EXISTS(SELECT 1 FROM payments p WHERE p.order_id = o.id) AS has_payments
    FROM orders o WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL LIMIT 1`,
  )
    .bind(context.req.param("orderId"), context.get("userId"))
    .first<{ id: string; has_payments: number }>();
  if (!existing) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }
  if (existing.has_payments) {
    return apiError(context, 409, "ORDER_LOCKED", "Orders cannot be edited after the first payment.");
  }

  const totalCents = calculateOrderTotal(parsed.data.items);
  const statements = [
    context.env.DB.prepare(
      `UPDATE orders SET customer = ?, due_date = ?, total_cents = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ).bind(parsed.data.customer, parsed.data.dueDate, totalCents, existing.id, context.get("userId")),
    context.env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(existing.id),
    ...parsed.data.items.map((item, position) =>
      context.env.DB.prepare(
        `INSERT INTO order_items
          (id, order_id, description, quantity, unit_price_cents, line_total_cents, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), existing.id, item.description, item.quantity, item.unitPriceCents,
        item.quantity * item.unitPriceCents, position,
      ),
    ),
    auditStatement(context, existing.id, "order.updated", {
      customer: parsed.data.customer,
      totalCents,
      dueDate: parsed.data.dueDate,
      lineItemCount: parsed.data.items.length,
    }),
  ];

  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ORDER_LOCKED_AFTER_PAYMENT")) {
      return apiError(context, 409, "ORDER_LOCKED", "Orders cannot be edited after the first payment.");
    }
    throw error;
  }
  return context.json({ data: { order: { id: existing.id, totalCents } } });
});

app.delete("/api/orders/:orderId", async (context) => {
  const existing = await context.env.DB.prepare(
    `SELECT o.id, EXISTS(SELECT 1 FROM payments p WHERE p.order_id = o.id) AS has_payments
     FROM orders o
     WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL LIMIT 1`,
  )
    .bind(context.req.param("orderId"), context.get("userId"))
    .first<{ id: string; has_payments: number }>();
  if (!existing) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }
  if (existing.has_payments) {
    return apiError(context, 409, "ORDER_LOCKED", "Orders cannot be deleted after the first payment.");
  }
  await context.env.DB.prepare(
    "UPDATE orders SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  )
    .bind(existing.id, context.get("userId"))
    .run();
  return context.body(null, 204);
});

app.post("/api/orders/:orderId/payments", async (context) => {
  const rateLimited = await consumeRateLimit(
    context,
    "payment.create",
    context.get("userId"),
    30,
    60,
  );
  if (rateLimited) return rateLimited;
  const idempotencyKey = context.req.header("Idempotency-Key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return apiError(
      context,
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Provide an Idempotency-Key header containing 8 to 200 letters, numbers, dots, colons, underscores, or hyphens.",
    );
  }

  const parsed = paymentSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the payment fields.", {
      details: parsed.error.flatten(),
    });
  }

  const userId = context.get("userId");
  const orderId = context.req.param("orderId");
  const keyHash = await sha256(idempotencyKey);
  const payloadHash = await sha256(paymentPayloadHashInput(orderId, parsed.data));
  const existingIdempotency = await context.env.DB.prepare(
    `SELECT payload_hash, response_json FROM idempotency_records
     WHERE user_id = ? AND operation = ? AND key_hash = ? LIMIT 1`,
  )
    .bind(userId, PAYMENT_OPERATION, keyHash)
    .first<IdempotencyRow>();
  if (existingIdempotency) {
    if (existingIdempotency.payload_hash !== payloadHash) {
      return apiError(
        context,
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with different payment details. Use a new key.",
      );
    }
    context.header("Idempotency-Replayed", "true");
    return context.json(JSON.parse(existingIdempotency.response_json) as { data: unknown }, 201);
  }

  const balance = await context.env.DB.prepare(
    `SELECT o.total_cents,
      COALESCE(SUM(p.amount_cents), 0) AS amount_paid_cents,
      o.total_cents - COALESCE(SUM(p.amount_cents), 0) AS amount_due_cents
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL
     GROUP BY o.id LIMIT 1`,
  )
    .bind(orderId, userId)
    .first<{ total_cents: number; amount_paid_cents: number; amount_due_cents: number }>();
  if (!balance) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }
  if (parsed.data.amountCents > balance.amount_due_cents) {
    return apiError(
      context,
      409,
      "OVERPAYMENT",
      `Payment exceeds the remaining balance. Maximum allowed: ${formatUsd(balance.amount_due_cents)}.`,
      { field: "amount", maxAllowedCents: balance.amount_due_cents },
    );
  }

  const paymentId = crypto.randomUUID();
  const responseBody = { data: { payment: { id: paymentId, amountCents: parsed.data.amountCents } } };
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO payments (id, order_id, amount_cents, payment_date, note) VALUES (?, ?, ?, ?, ?)",
      ).bind(paymentId, orderId, parsed.data.amountCents, parsed.data.paymentDate, parsed.data.note ?? null),
      context.env.DB.prepare(
        `INSERT INTO idempotency_records
          (user_id, operation, key_hash, payload_hash, payment_id, response_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(userId, PAYMENT_OPERATION, keyHash, payloadHash, paymentId, JSON.stringify(responseBody)),
      auditStatement(context, orderId, "payment.recorded", {
        paymentId,
        amountCents: parsed.data.amountCents,
        paymentDate: parsed.data.paymentDate,
      }),
      ...(balance.amount_paid_cents === 0
        ? [auditStatement(context, orderId, "order.locked", { paymentId })]
        : []),
      ...(balance.amount_due_cents === parsed.data.amountCents
        ? [auditStatement(context, orderId, "order.paid", { paymentId })]
        : []),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("PAYMENT_EXCEEDS_ORDER_BALANCE")) {
      const latest = await context.env.DB.prepare(
        `SELECT o.total_cents - COALESCE(SUM(p.amount_cents), 0) AS amount_due_cents
         FROM orders o LEFT JOIN payments p ON p.order_id = o.id
         WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL GROUP BY o.id`,
      )
        .bind(orderId, userId)
        .first<{ amount_due_cents: number }>();
      const maximumAmountCents = Math.max(latest?.amount_due_cents ?? 0, 0);
      return apiError(
        context,
        409,
        "OVERPAYMENT",
        `Payment exceeds the remaining balance. Maximum allowed: ${formatUsd(maximumAmountCents)}.`,
        { field: "amount", maxAllowedCents: maximumAmountCents },
      );
    }
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      const racedRecord = await context.env.DB.prepare(
        `SELECT payload_hash, response_json FROM idempotency_records
         WHERE user_id = ? AND operation = ? AND key_hash = ? LIMIT 1`,
      )
        .bind(userId, PAYMENT_OPERATION, keyHash)
        .first<IdempotencyRow>();
      if (racedRecord?.payload_hash === payloadHash) {
        context.header("Idempotency-Replayed", "true");
        return context.json(JSON.parse(racedRecord.response_json) as { data: unknown }, 201);
      }
      if (racedRecord) {
        return apiError(
          context,
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with different payment details. Use a new key.",
        );
      }
    }
    throw error;
  }

  return context.json(responseBody, 201);
});

app.notFound((context) => {
  if (context.req.path.startsWith("/api/")) {
    return apiError(context, 404, "NOT_FOUND", "The requested API endpoint does not exist.");
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  if (error instanceof ApiFailure) {
    return apiError(context, error.status, error.code, error.message, error.options);
  }
  console.error(JSON.stringify({
    event: "unhandled_error",
    requestId: context.get("requestId"),
    message: error.message,
  }));
  return apiError(context, 500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.", {
    retryable: true,
  });
});

export default app;