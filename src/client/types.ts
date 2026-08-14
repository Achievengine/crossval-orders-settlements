import type { OrderStatus } from "../shared/domain";

export type User = { id: string; email: string };

export type OrderSummary = {
  id: string;
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
  amountCents: number;
  paymentDate: string;
  note: string | null;
  createdAt: string;
};

export type OrderDetail = OrderSummary & {
  items: OrderItem[];
  payments: Payment[];
  isEditable: boolean;
};