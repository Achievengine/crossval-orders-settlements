import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import app from "../src/worker";

type ApiResponse<T> = { data: T } | { error: { code: string; message: string; details?: unknown; request_id: string; max_allowed_cents?: number } };

async function request<T>(path: string, init?: RequestInit, cookie?: string) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const response = await app.request(path, { ...init, headers }, env);
  const body = response.status === 204 ? undefined : (await response.json()) as ApiResponse<T>;
  return { response, body };
}

async function signup(email: string): Promise<string> {
  const { response } = await request("/api/auth/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": email },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  return setCookie?.split(";")[0] ?? "";
}

async function createOrder(cookie: string, dueDate = "2099-01-01"): Promise<string> {
  const { response, body } = await request<{ order: { id: string; totalCents: number } }>(
    "/api/orders",
    {
      method: "POST",
      body: JSON.stringify({
        customer: "Acme Holdings",
        dueDate,
        items: [{ description: "Implementation", quantity: 2, unitPriceCents: 50_000 }],
      }),
    },
    cookie,
  );
  expect(response.status).toBe(201);
  if (!body || !("data" in body)) {
    throw new Error("Order creation did not return data");
  }
  expect(body.data.order.totalCents).toBe(100_000);
  return body.data.order.id;
}

async function pay(
  orderId: string,
  amountCents: number,
  cookie: string,
  idempotencyKey = crypto.randomUUID(),
) {
  return request<{ payment: { id: string; amountCents: number } }>(
    `/api/orders/${orderId}/payments`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ amountCents, paymentDate: "2026-08-14", note: "Bank transfer" }),
    },
    cookie,
  );
}

describe("orders and settlements API", () => {
  it("runs the required partial, full, immutable, and overpayment scenario", async () => {
    const cookie = await signup("scenario@example.com");
    const orderId = await createOrder(cookie);

    expect((await pay(orderId, 40_000, cookie)).response.status).toBe(201);
    const partial = await request<{ order: { status: string; amountPaidCents: number; amountDueCents: number } }>(
      `/api/orders/${orderId}`,
      undefined,
      cookie,
    );
    expect(partial.body).toMatchObject({
      data: { order: { status: "partially_paid", amountPaidCents: 40_000, amountDueCents: 60_000 } },
    });

    const edit = await request(
      `/api/orders/${orderId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          customer: "Changed",
          dueDate: "2099-02-01",
          items: [{ description: "Changed", quantity: 1, unitPriceCents: 1 }],
        }),
      },
      cookie,
    );
    expect(edit.response.status).toBe(409);
    expect(edit.body).toMatchObject({ error: { code: "ORDER_LOCKED" } });

    expect((await pay(orderId, 60_000, cookie)).response.status).toBe(201);
    const paid = await request<{ order: { status: string; amountPaidCents: number; amountDueCents: number } }>(
      `/api/orders/${orderId}`,
      undefined,
      cookie,
    );
    expect(paid.body).toMatchObject({
      data: { order: { status: "paid", amountPaidCents: 100_000, amountDueCents: 0 } },
    });

    const overpayment = await pay(orderId, 100, cookie);
    expect(overpayment.response.status).toBe(409);
    expect(overpayment.body).toMatchObject({
      error: {
        code: "OVERPAYMENT",
        max_allowed_cents: 0,
      },
    });
    expect(overpayment.body && "error" in overpayment.body ? overpayment.body.error.message : "").toContain(
      "maximum allowed amount is 0 cents",
    );
  });

  it("rejects unauthenticated and cross-user order access", async () => {
    const unauthenticated = await request("/api/orders");
    expect(unauthenticated.response.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const ownerCookie = await signup("owner@example.com");
    const orderId = await createOrder(ownerCookie);
    const otherCookie = await signup("other@example.com");
    const crossUser = await request(`/api/orders/${orderId}`, undefined, otherCookie);
    expect(crossUser.response.status).toBe(404);
  });

  it("derives overdue unpaid, overdue partial, and paid past-due states", async () => {
    const cookie = await signup("overdue@example.com");
    const unpaidId = await createOrder(cookie, "2000-01-01");
    const partialId = await createOrder(cookie, "2000-01-02");
    const paidId = await createOrder(cookie, "2000-01-03");
    await pay(partialId, 40_000, cookie);
    await pay(paidId, 100_000, cookie);

    const list = await request<{ orders: Array<{ id: string; status: string }> }>("/api/orders", undefined, cookie);
    if (!list.body || !("data" in list.body)) {
      throw new Error("Order list did not return data");
    }
    const statuses = new Map(list.body.data.orders.map((order) => [order.id, order.status]));
    expect(statuses.get(unpaidId)).toBe("overdue");
    expect(statuses.get(partialId)).toBe("overdue");
    expect(statuses.get(paidId)).toBe("paid");
  });

  it("uses the database trigger to prevent rapid overpayment attempts", async () => {
    const cookie = await signup("concurrency@example.com");
    const orderId = await createOrder(cookie);
    await pay(orderId, 40_000, cookie);

    const results = await Promise.all([pay(orderId, 60_000, cookie), pay(orderId, 60_000, cookie)]);
    expect(results.map((result) => result.response.status).sort()).toEqual([201, 409]);

    const total = await env.DB.prepare("SELECT SUM(amount_cents) AS paid FROM payments WHERE order_id = ?")
      .bind(orderId)
      .first<{ paid: number }>();
    expect(total?.paid).toBe(100_000);
  });

  it("replays the original payment for the same idempotency key and payload", async () => {
    // #given
    const cookie = await signup("idempotent-replay@example.com");
    const orderId = await createOrder(cookie);
    const key = "payment-replay-key";

    // #when
    const first = await pay(orderId, 40_000, cookie, key);
    const replay = await pay(orderId, 40_000, cookie, key);

    // #then
    expect(replay.response.status).toBe(201);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?")
      .bind(orderId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("rejects an idempotency key reused with different payment details", async () => {
    // #given
    const cookie = await signup("idempotent-mismatch@example.com");
    const orderId = await createOrder(cookie);
    const key = "payment-mismatch-key";
    await pay(orderId, 40_000, cookie, key);

    // #when
    const mismatch = await pay(orderId, 60_000, cookie, key);

    // #then
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("creates one payment when identical idempotent requests race", async () => {
    // #given
    const cookie = await signup("idempotent-race@example.com");
    const orderId = await createOrder(cookie);
    const key = "payment-concurrent-key";

    // #when
    const results = await Promise.all([
      pay(orderId, 40_000, cookie, key),
      pay(orderId, 40_000, cookie, key),
    ]);

    // #then
    expect(results.every((result) => result.response.status === 201)).toBe(true);
    const ids = results.map((result) =>
      result.body && "data" in result.body ? result.body.data.payment.id : undefined,
    );
    expect(new Set(ids).size).toBe(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?")
      .bind(orderId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("scopes idempotency keys to each authenticated user", async () => {
    // #given
    const userACookie = await signup("idempotent-user-a@example.com");
    const userBCookie = await signup("idempotent-user-b@example.com");
    const userAOrder = await createOrder(userACookie);
    const userBOrder = await createOrder(userBCookie);
    const sharedKey = "shared-across-users";

    // #when
    const userAResult = await pay(userAOrder, 40_000, userACookie, sharedKey);
    const userBResult = await pay(userBOrder, 40_000, userBCookie, sharedKey);

    // #then
    expect(userAResult.response.status).toBe(201);
    expect(userBResult.response.status).toBe(201);
  });

  it("records an owner-scoped immutable audit timeline", async () => {
    // #given
    const cookie = await signup("audit-owner@example.com");
    const orderId = await createOrder(cookie);

    // #when
    await pay(orderId, 40_000, cookie, "audit-payment-key");
    const detail = await request<{
      order: { auditEvents: Array<{ eventType: string; metadata: Record<string, unknown> }> };
    }>(`/api/orders/${orderId}`, undefined, cookie);

    // #then
    expect(detail.body).toMatchObject({
      data: {
        order: {
          auditEvents: [
            { eventType: "order.created" },
            { eventType: "payment.recorded", metadata: { amountCents: 40_000 } },
            { eventType: "order.locked" },
          ],
        },
      },
    });
  });

  it("prevents audit event updates and deletes at the database layer", async () => {
    // #given
    const cookie = await signup("audit-immutable@example.com");
    const orderId = await createOrder(cookie);
    const event = await env.DB.prepare("SELECT id FROM audit_events WHERE order_id = ? LIMIT 1")
      .bind(orderId)
      .first<{ id: string }>();

    // #when / #then
    await expect(env.DB.prepare("UPDATE audit_events SET event_type = 'order.updated' WHERE id = ?")
      .bind(event?.id)
      .run()).rejects.toThrow("AUDIT_EVENTS_ARE_IMMUTABLE");
    await expect(env.DB.prepare("DELETE FROM audit_events WHERE id = ?")
      .bind(event?.id)
      .run()).rejects.toThrow("AUDIT_EVENTS_ARE_IMMUTABLE");
  });

  it("records lock and paid events when the first payment settles the order", async () => {
    // #given
    const cookie = await signup("audit-full-first@example.com");
    const orderId = await createOrder(cookie);

    // #when
    await pay(orderId, 100_000, cookie, "audit-full-first-key");
    const events = await env.DB.prepare(
      "SELECT event_type FROM audit_events WHERE order_id = ? ORDER BY rowid",
    )
      .bind(orderId)
      .all<{ event_type: string }>();

    // #then
    expect(events.results.map((event) => event.event_type)).toEqual([
      "order.created",
      "payment.recorded",
      "order.locked",
      "order.paid",
    ]);
  });

  it("returns correlated structured errors and rejects unsafe requests", async () => {
    // #given / #when
    const unauthenticated = await request("/api/orders");
    const unsupported = await request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json",
    });
    const crossOrigin = await request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ email: "origin@example.com", password: "password123" }),
    });
    const oversized = await request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "40000" },
      body: JSON.stringify({ email: "large@example.com", password: "password123" }),
    });

    // #then
    expect(unauthenticated.response.headers.get("X-Request-Id")).toMatch(/^req_/);
    expect(unauthenticated.body).toMatchObject({
      error: { code: "UNAUTHENTICATED", request_id: unauthenticated.response.headers.get("X-Request-Id") },
    });
    expect(unsupported.response.status).toBe(415);
    expect(crossOrigin.response.status).toBe(403);
    expect(oversized.response.status).toBe(413);
  });

  it("rate limits repeated payment writes with a retry hint", async () => {
    // #given
    const cookie = await signup("payment-rate-limit@example.com");
    const orderId = await createOrder(cookie);

    // #when
    const attempts = [];
    for (let index = 0; index < 31; index += 1) {
      attempts.push(await request(`/api/orders/${orderId}/payments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: 1, paymentDate: "2026-08-14" }),
      }, cookie));
    }
    const limited = attempts.at(-1);

    // #then
    expect(limited?.response.status).toBe(429);
    expect(limited?.response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(limited?.body).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
  });

  it("creates a fresh owner-scoped demo scenario on every request", async () => {
    // #given
    const userACookie = await signup("demo-user-a@example.com");
    const userBCookie = await signup("demo-user-b@example.com");

    // #when
    const first = await request<{ order: { id: string } }>("/api/demo", { method: "POST" }, userACookie);
    const second = await request<{ order: { id: string } }>("/api/demo", { method: "POST" }, userACookie);
    const userBOrders = await request<{ orders: Array<{ id: string }> }>("/api/orders", undefined, userBCookie);

    // #then
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    const firstId = first.body && "data" in first.body ? first.body.data.order.id : undefined;
    const secondId = second.body && "data" in second.body ? second.body.data.order.id : undefined;
    expect(firstId).not.toBe(secondId);
    expect(userBOrders.body).toMatchObject({ data: { orders: [] } });
  });

  it("exports only owner orders and neutralizes CSV formula prefixes", async () => {
    // #given
    const ownerCookie = await signup("csv-owner@example.com");
    const otherCookie = await signup("csv-other@example.com");
    await request("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customer: "=SUM(A1:A2)",
        dueDate: "2099-01-01",
        items: [{ description: "Service", quantity: 1, unitPriceCents: 100 }],
      }),
    }, ownerCookie);
    await createOrder(otherCookie);

    // #when
    const response = await app.request("/api/orders.csv", {
      headers: { Cookie: ownerCookie },
    }, env);
    const csv = await response.text();

    // #then
    expect(response.status).toBe(200);
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).not.toContain("Acme Holdings");
  });

  it("soft deletes an unpaid order while preserving its audit history", async () => {
    // #given
    const cookie = await signup("soft-delete@example.com");
    const orderId = await createOrder(cookie);

    // #when
    const deleted = await request(`/api/orders/${orderId}`, { method: "DELETE" }, cookie);
    const detail = await request(`/api/orders/${orderId}`, undefined, cookie);
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ count: number }>();

    // #then
    expect(deleted.response.status).toBe(204);
    expect(detail.response.status).toBe(404);
    expect(auditCount?.count).toBe(1);
  });
});