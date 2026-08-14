import type { OrderStatus } from "../shared/domain";

export type User = { id: string; email: string };

export type OrderSummary = {
  id: string;
  orderNumber: string;
  customer: string;
  dueDate: string;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
};

export type OrderItem = {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  position: number;
};

export type Payment = {
  id: string;
  reference: string;
  amountCents: number;
  paymentDate: string;
  note: string | null;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  eventType: "order.created" | "order.updated" | "payment.recorded" | "order.locked" | "order.paid";
  actorUserId: string;
  requestId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type OrderDetail = OrderSummary & {
  items: OrderItem[];
  payments: Payment[];
  auditEvents: AuditEvent[];
  isEditable: boolean;
};