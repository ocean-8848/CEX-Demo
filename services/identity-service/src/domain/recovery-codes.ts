import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One-time 2FA recovery codes.
 *
 * - Generated when 2FA is enabled (or regenerated), shown to the user exactly once.
 * - Only a SHA-256 hash (salted with the userId) is stored; a used code is marked
 *   `used_at` and can never be used again.
 * - Format `xxxx-xxxx` (lowercase base32, no ambiguous 0/1/8/9), so it can never be
 *   confused with a 6-digit TOTP code.
 */
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_PATTERN = /^[a-z2-7]{4}-?[a-z2-7]{4}$/;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = randomBytes(8);
    let raw = "";
    for (const byte of bytes) {
      raw += RECOVERY_ALPHABET[byte & 31];
    }
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return [...codes];
}

/** Lowercases, trims and strips spaces so "ABCD EFGH" / "abcd-efgh" are equivalent. */
export function normalizeRecoveryCode(code: string): string {
  const compact = code.trim().toLowerCase().replace(/[\s-]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function looksLikeRecoveryCode(code: string): boolean {
  return RECOVERY_CODE_PATTERN.test(code.trim().toLowerCase().replace(/\s/g, ""));
}

export function hashRecoveryCode(userId: string, code: string): string {
  return createHash("sha256")
    .update(`recovery:${userId}:${normalizeRecoveryCode(code)}`)
    .digest("hex");
}

export function recoveryCodeHashMatches(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
