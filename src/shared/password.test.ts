import { describe, expect, it } from "vitest";

import { assessPassword } from "./password";

describe("password strength", () => {
  it("rejects passwords below the shared minimum", () => {
    // #given / #when
    const assessment = assessPassword("Short1!");

    // #then
    expect(assessment.meetsMinimum).toBe(false);
    expect(assessment.strength).toBe("weak");
    expect(assessment.score).toBe(1);
    expect(assessment.suggestion).toContain("at least 8 characters");
  });

  it("recognizes a long mixed password as very strong", () => {
    // #given / #when
    const assessment = assessPassword("Ledgerly-Secure-2026!");

    // #then
    expect(assessment).toMatchObject({
      score: 5,
      strength: "very-strong",
      meetsMinimum: true,
    });
  });

  it("gives a targeted next improvement", () => {
    // #given / #when
    const assessment = assessPassword("longlowercasepassword");

    // #then
    expect(assessment.strength).toBe("fair");
    expect(assessment.suggestion).toBe("Mix uppercase and lowercase letters.");
  });
});