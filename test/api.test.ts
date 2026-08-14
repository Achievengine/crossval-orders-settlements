import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import app from "../src/worker";

type ApiResponse<T> = { data: T } | { error: { code: string; message: string; details?: unknown } };

async function request<T>(path: string, init?: RequestInit, cookie?: string) {
  const headers = new Headers(init?.headers);
  if (init?.body) {
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

async function pay(orderId: string, amountCents: number, cookie: string) {
  return request<{ payment: { id: string; amountCents: number } }>(
    `/api/orders/${orderId}/payments`,
    {
      method: "POST",
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
        details: { maximumAmountCents: 0 },
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
});