import { describe, expect, it } from "vitest";

import { calculateOrderTotal, deriveOrderStatus } from "./domain";

describe("order domain rules", () => {
  it("calculates two $500 line items as $1,000", () => {
    expect(calculateOrderTotal([{ quantity: 2, unitPriceCents: 50_000 }])).toBe(100_000);
  });

  it("derives payment and overdue states with paid taking precedence", () => {
    expect(deriveOrderStatus(100_000, 40_000, "2099-01-01", "2026-08-14")).toBe("partially_paid");
    expect(deriveOrderStatus(100_000, 0, "2000-01-01", "2026-08-14")).toBe("overdue");
    expect(deriveOrderStatus(100_000, 40_000, "2000-01-01", "2026-08-14")).toBe("overdue");
    expect(deriveOrderStatus(100_000, 100_000, "2000-01-01", "2026-08-14")).toBe("paid");
  });

  it("treats a due date as overdue only after the UTC calendar date passes", () => {
    // #given
    const dueDate = "2026-08-14";

    // #when / #then
    expect(deriveOrderStatus(100_000, 0, dueDate, "2026-08-14")).toBe("pending");
    expect(deriveOrderStatus(100_000, 0, dueDate, "2026-08-15")).toBe("overdue");
  });
});