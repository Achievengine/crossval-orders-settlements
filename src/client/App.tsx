import { FormEvent, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDollarSign,
  LogOut,
  Plus,
  ReceiptText,
  Trash2,
} from "lucide-react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";

import { ORDER_STATUSES, type OrderStatus } from "../shared/domain";
import { ApiError, apiRequest } from "./api";
import type { OrderDetail, OrderSummary, User } from "./types";

type AuthMode = "login" | "signup";
type LineItemDraft = { id: string; description: string; quantity: string; unitPrice: string };

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Pending",
  partially_paid: "Partially paid",
  paid: "Paid",
  overdue: "Overdue",
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatMoney(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(`${date}T00:00:00`),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>;
}

function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-bar" />
      <span className="loading-bar short" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await apiRequest<{ user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-context" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true"><ReceiptText size={22} /></div>
        <p className="product-name">Ledgerly</p>
        <h1 id="auth-title">Orders, settled with certainty.</h1>
        <p>Track customer orders, partial payments, and overdue balances in one accountable workspace.</p>
        <div className="auth-proof"><Check size={17} /> Totals computed and protected server-side</div>
      </section>

      <section className="auth-form-panel" aria-label={`${mode === "login" ? "Log in" : "Create account"} form`}>
        <div className="auth-form-wrap">
          <div className="segmented-control" aria-label="Authentication mode">
            <button type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>Log in</button>
            <button type="button" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>Sign up</button>
          </div>
          <div className="form-heading">
            <h2>{mode === "login" ? "Welcome back" : "Create your workspace"}</h2>
            <p>{mode === "login" ? "Enter your credentials to continue." : "Start tracking orders in under a minute."}</p>
          </div>
          <form className="form-stack" onSubmit={handleSubmit}>
            <label>
              Email address
              <input name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="button primary full" disabled={submitting} type="submit">
              {submitting ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function AppShell({ user, onLogout, children }: { user: User; onLogout: () => Promise<void>; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand-link" to="/">
          <span className="brand-mark small" aria-hidden="true"><ReceiptText size={18} /></span>
          <span>Ledgerly</span>
        </Link>
        <div className="topbar-actions">
          <span className="user-email">{user.email}</span>
          <button className="icon-button" type="button" onClick={() => void onLogout()} title="Log out" aria-label="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function DashboardPage() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = status === "all" ? "" : `?status=${status}`;
    apiRequest<{ orders: OrderSummary[] }>(`/api/orders${query}`, { signal: controller.signal })
      .then((result) => setOrders(result.orders))
      .catch((requestError: unknown) => {
        if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
          setError(errorMessage(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [status]);

  const outstandingCents = orders.reduce((total, order) => total + order.amountDueCents, 0);

  return (
    <main id="main-content" className="page-container">
      <div className="page-header">
        <div>
          <p className="context-label">Finance operations</p>
          <h1>Orders and settlements</h1>
          <p>Monitor receivables and record customer payments.</p>
        </div>
        <Link className="button primary" to="/orders/new"><Plus size={18} /> New order</Link>
      </div>

      <div className="summary-strip" aria-label="Order summary">
        <div><span>Visible orders</span><strong>{orders.length}</strong></div>
        <div><span>Outstanding</span><strong>{formatMoney(outstandingCents)}</strong></div>
      </div>

      <section className="orders-section" aria-labelledby="orders-heading">
        <div className="section-toolbar">
          <h2 id="orders-heading">Orders</h2>
          <label className="filter-control">
            <span>Status</span>
            <select name="status-filter" value={status} onChange={(event) => setStatus(event.target.value as OrderStatus | "all")}>
              <option value="all">All statuses</option>
              {ORDER_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </select>
          </label>
        </div>

        {loading ? <LoadingState label="Loading orders" /> : null}
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        {!loading && !error && orders.length === 0 ? (
          <div className="empty-state">
            <CircleDollarSign size={30} />
            <h3>{status === "all" ? "No orders yet" : `No ${STATUS_LABELS[status].toLowerCase()} orders`}</h3>
            <p>{status === "all" ? "Create an order to begin tracking its settlement." : "Choose another status or create a new order."}</p>
            {status === "all" ? <Link className="button secondary" to="/orders/new">Create first order</Link> : null}
          </div>
        ) : null}
        {!loading && orders.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Customer</th><th>Status</th><th>Order total</th><th>Amount paid</th><th>Amount due</th><th>Due date</th><th><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td data-label="Customer"><Link className="customer-link" to={`/orders/${order.id}`}>{order.customer}</Link></td>
                    <td data-label="Status"><StatusBadge status={order.status} /></td>
                    <td data-label="Order total" className="money">{formatMoney(order.totalCents)}</td>
                    <td data-label="Amount paid" className="money">{formatMoney(order.amountPaidCents)}</td>
                    <td data-label="Amount due" className="money strong">{formatMoney(order.amountDueCents)}</td>
                    <td data-label="Due date">{formatDate(order.dueDate)}</td>
                    <td className="row-action"><Link to={`/orders/${order.id}`} aria-label={`Open ${order.customer} order`}><ChevronRight size={18} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function OrderFormPage() {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [items, setItems] = useState<LineItemDraft[]>([
    { id: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "" },
  ]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const previewTotalCents = items.reduce((total, item) => {
    const quantity = Number.parseInt(item.quantity, 10);
    const price = Number.parseFloat(item.unitPrice);
    return total + (Number.isFinite(quantity) && Number.isFinite(price) ? quantity * Math.round(price * 100) : 0);
  }, 0);

  function updateItem(id: string, field: keyof Omit<LineItemDraft, "id">, value: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await apiRequest<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          customer,
          dueDate,
          items: items.map((item) => ({
            description: item.description,
            quantity: Number.parseInt(item.quantity, 10),
            unitPriceCents: Math.round(Number.parseFloat(item.unitPrice) * 100),
          })),
        }),
      });
      navigate(`/orders/${result.order.id}`);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main id="main-content" className="page-container narrow">
      <Link className="back-link" to="/"><ArrowLeft size={17} /> Back to orders</Link>
      <div className="page-header compact"><div><h1>Create order</h1><p>Totals are calculated again by the server before saving.</p></div></div>
      <form className="order-form" onSubmit={handleSubmit}>
        <section className="form-section" aria-labelledby="order-details-heading">
          <h2 id="order-details-heading">Order details</h2>
          <div className="field-grid">
            <label>Customer name<input name="customer" value={customer} onChange={(event) => setCustomer(event.target.value)} maxLength={200} required /></label>
            <label>Due date<input name="due-date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label>
          </div>
        </section>
        <section className="form-section" aria-labelledby="line-items-heading">
          <div className="section-toolbar"><h2 id="line-items-heading">Line items</h2><button className="button text" type="button" onClick={() => setItems((current) => [...current, { id: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "" }])}><Plus size={17} /> Add item</button></div>
          <div className="line-items">
            {items.map((item, index) => (
              <div className="line-item" key={item.id}>
                <span className="line-number">{index + 1}</span>
                <label className="description-field">Description<input name={`item-${index}-description`} value={item.description} onChange={(event) => updateItem(item.id, "description", event.target.value)} required /></label>
                <label>Quantity<input name={`item-${index}-quantity`} type="number" min="1" step="1" value={item.quantity} onChange={(event) => updateItem(item.id, "quantity", event.target.value)} required /></label>
                <label>Unit price (USD)<input name={`item-${index}-unit-price`} type="number" min="0.01" step="0.01" inputMode="decimal" value={item.unitPrice} onChange={(event) => updateItem(item.id, "unitPrice", event.target.value)} required /></label>
                <button className="icon-button danger" type="button" title="Remove item" aria-label={`Remove item ${index + 1}`} disabled={items.length === 1} onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}><Trash2 size={17} /></button>
              </div>
            ))}
          </div>
          <div className="order-total"><span>Order total</span><strong>{formatMoney(previewTotalCents)}</strong></div>
        </section>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions"><Link className="button secondary" to="/">Cancel</Link><button className="button primary" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create order"}</button></div>
      </form>
    </main>
  );
}

function OrderDetailPage() {
  const { orderId = "" } = useParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest<{ order: OrderDetail }>(`/api/orders/${orderId}`, { signal: controller.signal })
      .then((result) => { setOrder(result.order); setError(""); })
      .catch((requestError: unknown) => {
        if (!(requestError instanceof DOMException && requestError.name === "AbortError")) setError(errorMessage(requestError));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [orderId, refreshKey]);

  async function handlePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPaymentError("");
    setSubmitting(true);
    try {
      await apiRequest(`/api/orders/${orderId}/payments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: Math.round(Number.parseFloat(paymentAmount) * 100), paymentDate, note: note || undefined }),
      });
      setPaymentAmount("");
      setNote("");
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "OVERPAYMENT") {
        const maximum = Number(requestError.details?.maximumAmountCents ?? 0);
        setPaymentError(`That payment is too large. Enter ${formatMoney(maximum)} or less.`);
      } else {
        setPaymentError(errorMessage(requestError));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <main className="page-container"><LoadingState label="Loading order" /></main>;
  if (error || !order) return <main className="page-container"><Link className="back-link" to="/"><ArrowLeft size={17} /> Back to orders</Link><div className="inline-error" role="alert">{error || "Order not found."}</div></main>;

  return (
    <main id="main-content" className="page-container">
      <Link className="back-link" to="/"><ArrowLeft size={17} /> Back to orders</Link>
      <div className="detail-header">
        <div><div className="detail-title-row"><h1>{order.customer}</h1><StatusBadge status={order.status} /></div><p>Due {formatDate(order.dueDate)} · Created {formatDate(order.createdAt.slice(0, 10))}</p></div>
        {!order.isEditable ? <span className="locked-note">Read-only after first payment</span> : null}
      </div>
      <div className="amount-band" aria-label="Order amounts">
        <div><span>Order total</span><strong>{formatMoney(order.totalCents)}</strong></div>
        <div><span>Amount paid</span><strong>{formatMoney(order.amountPaidCents)}</strong></div>
        <div className="amount-due"><span>Amount due</span><strong>{formatMoney(order.amountDueCents)}</strong></div>
      </div>

      <div className="detail-layout">
        <div className="detail-main">
          <section className="detail-section" aria-labelledby="items-heading"><h2 id="items-heading">Line items</h2><div className="table-scroll"><table className="compact-table"><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>{order.items.map((item) => <tr key={item.id}><td data-label="Description">{item.description}</td><td data-label="Quantity">{item.quantity}</td><td data-label="Unit price" className="money">{formatMoney(item.unitPriceCents)}</td><td data-label="Amount" className="money strong">{formatMoney(item.lineTotalCents)}</td></tr>)}</tbody></table></div></section>
          <section className="detail-section" aria-labelledby="history-heading"><h2 id="history-heading">Payment history</h2>{order.payments.length === 0 ? <p className="muted-copy">No payments recorded.</p> : <div className="payment-list">{order.payments.map((payment) => <div className="payment-row" key={payment.id}><span className="payment-icon"><Check size={16} /></span><div><strong>{formatMoney(payment.amountCents)}</strong><span>{formatDate(payment.paymentDate)}{payment.note ? ` · ${payment.note}` : ""}</span></div></div>)}</div>}</section>
        </div>
        <aside className="payment-panel" aria-labelledby="record-payment-heading">
          <h2 id="record-payment-heading">Record payment</h2>
          {order.amountDueCents === 0 ? <div className="paid-message"><Check size={20} /><div><strong>Order settled</strong><span>No balance remains.</span></div></div> : (
            <form className="form-stack" onSubmit={handlePayment}>
              <label>Amount (USD)<input name="payment-amount" type="number" min="0.01" max={(order.amountDueCents / 100).toFixed(2)} step="0.01" inputMode="decimal" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} required /><small>Maximum {formatMoney(order.amountDueCents)}</small></label>
              <label>Payment date<input name="payment-date" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} required /></label>
              <label>Note <span className="optional">Optional</span><textarea name="payment-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              {paymentError ? <p className="form-error" role="alert">{paymentError}</p> : null}
              <button className="button primary full" type="submit" disabled={submitting}>{submitting ? "Recording…" : "Record payment"}</button>
            </form>
          )}
        </aside>
      </div>
    </main>
  );
}

function AuthenticatedApp({ user, setUser }: { user: User; setUser: (user: User | null) => void }) {
  async function logout() {
    await apiRequest("/api/auth/logout", { method: "POST" });
    setUser(null);
  }
  return <AppShell user={user} onLogout={logout}><Routes><Route path="/" element={<DashboardPage />} /><Route path="/orders/new" element={<OrderFormPage />} /><Route path="/orders/:orderId" element={<OrderDetailPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></AppShell>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ user: User }>("/api/auth/me", { signal: controller.signal })
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => { if (!controller.signal.aborted) setCheckingSession(false); });
    return () => controller.abort();
  }, []);

  if (checkingSession) return <LoadingState label="Checking session" />;

  return <BrowserRouter>{user ? <AuthenticatedApp user={user} setUser={setUser} /> : <AuthPage onAuthenticated={setUser} />}</BrowserRouter>;
}