import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { ORDER_STATUSES, calculateOrderTotal, deriveOrderStatus } from "../shared/domain";

type Bindings = Env;
type Variables = { userId: string };

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

const SESSION_COOKIE = "crossval_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7;
const PBKDF2_ITERATIONS = 100_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const credentialsSchema = z.object({
  email: z.email().max(254).transform((email) => email.trim().toLowerCase()),
  password: z.string().min(8).max(128),
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
  context: Parameters<typeof app.notFound>[0] extends never ? never : Parameters<Parameters<typeof app.notFound>[0]>[0],
  status: 400 | 401 | 403 | 404 | 409 | 422,
  code: string,
  message: string,
  details?: unknown,
) {
  return context.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

async function parseBody(context: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

function formatOrder(row: OrderRow, today = new Date().toISOString().slice(0, 10)) {
  const amountDueCents = Math.max(row.total_cents - row.amount_paid_cents, 0);
  return {
    id: row.id,
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
    amountCents: row.amount_cents,
    paymentDate: row.payment_date,
    note: row.note,
    createdAt: row.created_at,
  };
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

app.use("/api/*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});

app.get("/api/health", async (context) => {
  const database = await context.env.DB.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
  return context.json({ data: { status: database?.healthy === 1 ? "ok" : "degraded" } });
});

app.post("/api/auth/signup", async (context) => {
  const parsed = credentialsSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the highlighted fields.", parsed.error.flatten());
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
  const parsed = credentialsSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Enter a valid email and password.", parsed.error.flatten());
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
     WHERE o.user_id = ?
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
  )
    .bind(context.get("userId"))
    .all<OrderRow>();
  const orders = rows.results.map((row) => formatOrder(row));
  return context.json({ data: { orders: requestedStatus ? orders.filter((order) => order.status === requestedStatus) : orders } });
});

app.post("/api/orders", async (context) => {
  const parsed = orderSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the order fields.", parsed.error.flatten());
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
     WHERE o.id = ? AND o.user_id = ?
     GROUP BY o.id
     LIMIT 1`,
  )
    .bind(context.req.param("orderId"), context.get("userId"))
    .first<OrderRow>();
  if (!order) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }

  const [items, payments] = await Promise.all([
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
  ]);
  return context.json({
    data: {
      order: {
        ...formatOrder(order),
        items: items.results.map(formatItem),
        payments: payments.results.map(formatPayment),
        isEditable: payments.results.length === 0,
      },
    },
  });
});

app.put("/api/orders/:orderId", async (context) => {
  const parsed = orderSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the order fields.", parsed.error.flatten());
  }

  const existing = await context.env.DB.prepare(
    `SELECT o.id, EXISTS(SELECT 1 FROM payments p WHERE p.order_id = o.id) AS has_payments
     FROM orders o WHERE o.id = ? AND o.user_id = ? LIMIT 1`,
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
       WHERE id = ? AND user_id = ?`,
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
  try {
    const result = await context.env.DB.prepare("DELETE FROM orders WHERE id = ? AND user_id = ?")
      .bind(context.req.param("orderId"), context.get("userId"))
      .run();
    if (!result.meta.changes) {
      return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("ORDER_LOCKED_AFTER_PAYMENT")) {
      return apiError(context, 409, "ORDER_LOCKED", "Orders cannot be deleted after the first payment.");
    }
    throw error;
  }
  return context.body(null, 204);
});

app.post("/api/orders/:orderId/payments", async (context) => {
  const parsed = paymentSchema.safeParse(await parseBody(context));
  if (!parsed.success) {
    return apiError(context, 422, "VALIDATION_ERROR", "Check the payment fields.", parsed.error.flatten());
  }

  const balance = await context.env.DB.prepare(
    `SELECT o.total_cents - COALESCE(SUM(p.amount_cents), 0) AS amount_due_cents
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
     WHERE o.id = ? AND o.user_id = ?
     GROUP BY o.id LIMIT 1`,
  )
    .bind(context.req.param("orderId"), context.get("userId"))
    .first<{ amount_due_cents: number }>();
  if (!balance) {
    return apiError(context, 404, "ORDER_NOT_FOUND", "Order not found.");
  }
  if (parsed.data.amountCents > balance.amount_due_cents) {
    return apiError(
      context,
      409,
      "OVERPAYMENT",
      `Payment exceeds the remaining balance. The maximum allowed amount is ${balance.amount_due_cents} cents.`,
      { maximumAmountCents: balance.amount_due_cents },
    );
  }

  const paymentId = crypto.randomUUID();
  try {
    await context.env.DB.prepare(
      "INSERT INTO payments (id, order_id, amount_cents, payment_date, note) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(paymentId, context.req.param("orderId"), parsed.data.amountCents, parsed.data.paymentDate, parsed.data.note ?? null)
      .run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("PAYMENT_EXCEEDS_ORDER_BALANCE")) {
      const latest = await context.env.DB.prepare(
        `SELECT o.total_cents - COALESCE(SUM(p.amount_cents), 0) AS amount_due_cents
         FROM orders o LEFT JOIN payments p ON p.order_id = o.id
         WHERE o.id = ? AND o.user_id = ? GROUP BY o.id`,
      )
        .bind(context.req.param("orderId"), context.get("userId"))
        .first<{ amount_due_cents: number }>();
      const maximumAmountCents = Math.max(latest?.amount_due_cents ?? 0, 0);
      return apiError(
        context,
        409,
        "OVERPAYMENT",
        `Payment exceeds the remaining balance. The maximum allowed amount is ${maximumAmountCents} cents.`,
        { maximumAmountCents },
      );
    }
    throw error;
  }

  return context.json({ data: { payment: { id: paymentId, amountCents: parsed.data.amountCents } } }, 201);
});

app.notFound((context) =>
  context.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "The requested API endpoint does not exist.",
      },
    },
    404,
  ),
);

app.onError((error, context) => {
  console.error(JSON.stringify({ event: "unhandled_error", message: error.message }));
  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Please try again.",
      },
    },
    500,
  );
});

export default app;