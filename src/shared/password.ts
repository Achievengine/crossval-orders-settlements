export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordStrength = "weak" | "fair" | "good" | "strong" | "very-strong";

export type PasswordAssessment = {
  score: number;
  strength: PasswordStrength;
  label: string;
  meetsMinimum: boolean;
  checks: {
    minimumLength: boolean;
    recommendedLength: boolean;
    mixedCase: boolean;
    number: boolean;
    symbol: boolean;
  };
  suggestion: string;
};

const STRENGTH_LABELS: Record<PasswordStrength, string> = {
  weak: "Weak",
  fair: "Fair",
  good: "Good",
  strong: "Strong",
  "very-strong": "Very strong",
};

export function assessPassword(password: string): PasswordAssessment {
  const checks = {
    minimumLength: password.length >= PASSWORD_MIN_LENGTH,
    recommendedLength: password.length >= 12,
    mixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };
  const rawScore = Object.values(checks).filter(Boolean).length;
  const score = checks.minimumLength ? rawScore : Math.min(rawScore, 1);
  const strength: PasswordStrength = score <= 1
    ? "weak"
    : score === 2
      ? "fair"
      : score === 3
        ? "good"
        : score === 4
          ? "strong"
          : "very-strong";
  const suggestion = !checks.minimumLength
    ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
    : !checks.recommendedLength
      ? "Use 12 or more characters for better resistance to guessing."
      : !checks.mixedCase
        ? "Mix uppercase and lowercase letters."
        : !checks.number
          ? "Add a number."
          : !checks.symbol
            ? "Add a symbol."
            : "This password uses a strong mix of length and character types.";

  return {
    score,
    strength,
    label: STRENGTH_LABELS[strength],
    meetsMinimum: checks.minimumLength && password.length <= PASSWORD_MAX_LENGTH,
    checks,
    suggestion,
  };
}