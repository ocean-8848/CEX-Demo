import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const PASSWORD_ALGORITHM = "sha512";
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = pbkdf2Sync(
    password,
    salt,
    PASSWORD_ITERATIONS,
    PASSWORD_KEY_LENGTH,
    PASSWORD_ALGORITHM
  ).toString("base64url");

  return [
    "pbkdf2",
    PASSWORD_ALGORITHM,
    String(PASSWORD_ITERATIONS),
    salt,
    derivedKey
  ].join("$");
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const [scheme, algorithm, iterationsValue, salt, expectedHash] = encodedHash.split("$");
  if (
    scheme !== "pbkdf2" ||
    !algorithm ||
    !iterationsValue ||
    !salt ||
    !expectedHash
  ) {
    return false;
  }

  const iterations = Number(iterationsValue);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  const derived = pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, algorithm);
  const expected = Buffer.from(expectedHash, "base64url");

  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
}
