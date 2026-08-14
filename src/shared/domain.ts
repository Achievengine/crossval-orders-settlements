export const ORDER_STATUSES = ["pending", "partially_paid", "paid", "overdue"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function deriveOrderStatus(
  totalCents: number,
  amountPaidCents: number,
  dueDate: string,
  today: string,
): OrderStatus {
  if (amountPaidCents >= totalCents) {
    return "paid";
  }

  if (dueDate < today) {
    return "overdue";
  }

  return amountPaidCents > 0 ? "partially_paid" : "pending";
}

export function calculateOrderTotal(
  items: ReadonlyArray<{ quantity: number; unitPriceCents: number }>,
): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
}