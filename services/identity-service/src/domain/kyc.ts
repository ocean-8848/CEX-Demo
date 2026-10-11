/**
 * KYC tiers (M4-4). Learning demo only: no real identity verification, no
 * document upload, and the "ID number" is a fake field that is masked before
 * it is stored.
 */
export const KYC_TIERS = ["unverified", "L1", "L2"] as const;
export type KycTier = (typeof KYC_TIERS)[number];
export type VerifiedKycTier = Exclude<KycTier, "unverified">;
export type KycRequestStatus = "pending" | "approved" | "rejected";

export function isKycTier(value: unknown): value is KycTier {
  return typeof value === "string" && (KYC_TIERS as readonly string[]).includes(value);
}

export function isVerifiedKycTier(value: unknown): value is VerifiedKycTier {
  return value === "L1" || value === "L2";
}

export function kycTierRank(tier: KycTier): number {
  return KYC_TIERS.indexOf(tier);
}

export interface KycSubmissionInput {
  requestedTier: unknown;
  fullName: unknown;
  idNumber: unknown;
}

export interface ValidKycSubmission {
  requestedTier: VerifiedKycTier;
  fullName: string;
  idNumberMasked: string;
}

/**
 * Validates a customer KYC submission against the current tier. Returns a
 * human-readable reason string instead of throwing so callers can map it to
 * their own error type.
 */
export function validateKycSubmission(
  currentTier: KycTier,
  input: KycSubmissionInput
): { ok: true; value: ValidKycSubmission } | { ok: false; reason: string } {
  if (!isVerifiedKycTier(input.requestedTier)) {
    return { ok: false, reason: "requestedTier must be L1 or L2" };
  }

  if (kycTierRank(input.requestedTier) <= kycTierRank(currentTier)) {
    return {
      ok: false,
      reason: `Requested tier ${input.requestedTier} must be higher than the current tier ${currentTier}`
    };
  }

  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  if (fullName.length < 2 || fullName.length > 64) {
    return { ok: false, reason: "fullName must be 2-64 characters" };
  }

  const idNumber = typeof input.idNumber === "string" ? input.idNumber.replace(/\s/g, "") : "";
  if (!/^[A-Za-z0-9]{6,32}$/.test(idNumber)) {
    return { ok: false, reason: "idNumber must be 6-32 letters or digits (demo field, do not use real data)" };
  }

  return {
    ok: true,
    value: {
      requestedTier: input.requestedTier,
      fullName,
      idNumberMasked: maskIdNumber(idNumber)
    }
  };
}

/** Only the last 4 characters survive; the demo never stores the raw value. */
export function maskIdNumber(idNumber: string): string {
  const compact = idNumber.replace(/\s/g, "");
  const tail = compact.slice(-4);
  return `${"*".repeat(Math.max(compact.length - 4, 2))}${tail}`;
}
