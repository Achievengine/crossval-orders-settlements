# Orders and Settlements

A small multi-tenant finance operations application for creating customer orders, recording partial or full payments, and monitoring settlement status.

**Live application:** https://crossval-orders-settlements.abenuteshome.workers.dev

## Architecture

- **Frontend:** React 19, Vite, TypeScript, React Router, and plain responsive CSS.
- **API:** A Hono REST API in the same Cloudflare Worker that serves the frontend.
- **Database:** One isolated Cloudflare D1 database with foreign keys, checks, indexes, and payment/order triggers.
- **Validation:** Zod validates all API input. Monetary totals are recalculated by the Worker.
- **Authentication:** Email/password with PBKDF2-SHA-256, random per-user salts, and hashed random session tokens. The browser receives only a `Secure`, `HttpOnly`, `SameSite=Strict` cookie.
- **Ownership:** Every order read or mutation includes the authenticated `user_id`. Cross-user order IDs return `404` rather than disclosing existence.

Cloudflare static asset routing sends `/api/*` through the Worker first and serves all other paths from the Vite build with SPA fallback. No INSEAT service, database, bucket, secret, domain, or repository is used.

## Local Setup

Prerequisites: Node.js 20 or newer, npm, and a Cloudflare account when deploying.

```bash
npm install
npm run cf-typegen
npm run db:migrate:local
npm run build
npm run dev:worker
```

The local Worker is available at `http://localhost:8787`. Vite-only UI development is available with `npm run dev`, but API flows require `npm run dev:worker`.

## D1 Migrations

Create and bind an isolated database:

```bash
npx wrangler d1 create crossval-orders-settlements-db
```

Copy the returned `database_id` into `wrangler.jsonc`, then run:

```bash
npm run cf-typegen
npm run db:migrate:local
npm run db:migrate:remote
```

The committed deployment uses D1 database `2a0d3b6b-0e17-4776-8a27-4e597111aab4` in the separate `Abenuteshome@gmail.com` Cloudflare account.

## API

All responses use either `{ "data": ... }` or `{ "error": { "code", "message", "details"? } }`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Worker and D1 health |
| `POST` | `/api/auth/signup` | Create an account and session |
| `POST` | `/api/auth/login` | Authenticate and create a session |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/auth/me` | Return the current user |
| `GET` | `/api/orders?status=` | List owner-scoped orders; optionally filter status |
| `POST` | `/api/orders` | Create an order and its line items atomically |
| `GET` | `/api/orders/:orderId` | Return order detail, items, and payment history |
| `PUT` | `/api/orders/:orderId` | Replace an unpaid order and its items atomically |
| `DELETE` | `/api/orders/:orderId` | Delete an unpaid order |
| `POST` | `/api/orders/:orderId/payments` | Record a partial or full payment |

## Business Rules

### Status derivation

Status is derived at read time from the server-side order total, payment sum, due date, and current UTC date:

1. `paid` when payments equal the order total. Paid takes precedence even when the due date is past.
2. `overdue` when the due date is past and the order is not fully paid. This includes unpaid and partially paid orders.
3. `partially_paid` when a non-overdue order has some payment but is not fully paid.
4. `pending` when a non-overdue order has no payments.

### Money policy

All money is represented as integer cents in API payloads, TypeScript domain logic, and D1. For example, `$500.00` is `50000`. The Worker computes each `quantity * unit_price_cents` and the full order total; it never trusts a client-provided total. D1 also checks positive unit prices, positive payment amounts, integer quantities, and line total arithmetic.

### Order immutability

An order becomes read-only after its first payment. This prevents changing the commercial document beneath a settlement history. The API checks this rule for an actionable `409 ORDER_LOCKED` response, while D1 triggers independently reject order or line-item updates/deletes after payment.

### Concurrency and overpayment

The payment endpoint performs an early balance check to provide a useful maximum amount, but correctness does not rely on that read. The D1 `payments_prevent_overpayment` `BEFORE INSERT` trigger atomically aborts any insert where:

```text
SUM(existing payments) + NEW.amount_cents > order.total_cents
```

The Worker translates `PAYMENT_EXCEEDS_ORDER_BALANCE` into `409 OVERPAYMENT` with `details.maximumAmountCents`. Concurrent or rapid requests therefore cannot settle above the order total: the database serializes writes and the trigger evaluates each insert against committed payment state. The test suite and live deployment both submit competing final payments and verify exactly one succeeds.

D1 `batch()` is used for related all-or-nothing writes: signup plus its initial session, order plus line items, and unpaid-order replacement.

## Testing and Validation

```bash
npm run cf-typegen
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

Vitest runs inside the Cloudflare Workers runtime with an isolated D1 instance and the real migration. Coverage includes:

- `2 × $500 = $1,000` server-side total.
- `$400` payment produces `partially_paid` and `$600` due.
- A further `$600` produces `paid` and `$0` due.
- A further `$1` is rejected with the maximum allowed amount.
- Overdue unpaid, overdue partial, and fully paid past-due status precedence.
- Unauthenticated rejection and cross-user isolation.
- Editing rejected after the first payment.
- Competing final payments cannot exceed the total.

## Assumptions and Tradeoffs

- USD is the only presentation currency; adding a per-order ISO currency code would be the next step for multi-currency use.
- Dates are calendar dates (`YYYY-MM-DD`), and overdue comparison uses the Worker’s UTC date.
- Passwords use PBKDF2-SHA-256 at the Workers runtime maximum of 100,000 iterations. A production system would prefer managed identity or benchmark a memory-hard Workers-compatible password service.
- Sessions expire after seven days. There is no email verification, password reset, MFA, rate limiting, or account recovery in this take-home scope.
- The dashboard fetches a bounded personal dataset without pagination. Cursor pagination and indexed server-side status/date filtering would be added for large tenants.
- Deleting an unpaid order is supported by the API but intentionally omitted from the initial UI to keep the primary workflow direct and avoid accidental destructive action.

## Before Production

- Add rate limiting, email verification, password recovery, MFA, breached-password checks, and session management.
- Add idempotency keys to payment creation for client retry safety, plus an append-only audit log.
- Add currency, tenant/workspace membership, roles, and explicit timezone settings.
- Add pagination, search, exports, reconciliation references, refunds, and payment-provider webhooks.
- Add CSP and other security headers, dependency/secret scanning, CI deployment, preview environments, backups, alerts, and broader browser accessibility tests.
- Replace external Google Fonts with a bundled font or a platform font stack to remove a third-party runtime dependency.

## Deployment and Cleanup

Deploy from the project directory:

```bash
npm run deploy
```

Delete the assignment Worker and D1 database after review:

```bash
npx wrangler delete crossval-orders-settlements
npx wrangler d1 delete crossval-orders-settlements-db
```

Both resources are standalone and can be removed without affecting any other service.