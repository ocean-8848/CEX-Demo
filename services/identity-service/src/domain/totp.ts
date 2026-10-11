import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function buildOtpAuthUri(params: {
  issuer: string;
  label: string;
  secret: string;
  digits: number;
  periodSeconds: number;
}): string {
  const issuer = encodeURIComponent(params.issuer);
  const label = encodeURIComponent(params.label);

  return `otpauth://totp/${issuer}:${label}?secret=${params.secret}&issuer=${issuer}&digits=${params.digits}&period=${params.periodSeconds}`;
}

export function generateTotpCode(
  secret: string,
  now: Date,
  periodSeconds = 30,
  digits = 6
): { code: string; counter: number } {
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);
  return {
    code: hotp(base32Decode(secret), counter, digits),
    counter
  };
}

export function verifyTotpCode(params: {
  secret: string;
  code: string;
  now: Date;
  periodSeconds?: number;
  digits?: number;
  window?: number;
}): number | null {
  const periodSeconds = params.periodSeconds ?? 30;
  const digits = params.digits ?? 6;
  const window = params.window ?? 1;
  const currentCounter = Math.floor(params.now.getTime() / 1000 / periodSeconds);
  const normalizedCode = params.code.trim();

  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0) {
      continue;
    }

    if (hotp(base32Decode(params.secret), counter, digits) === normalizedCode) {
      return counter;
    }
  }

  return null;
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const lastByte = digest.at(-1);
  if (lastByte === undefined) {
    throw new Error("HMAC digest is empty");
  }

  const offset = lastByte & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

function base32Encode(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value: string): Buffer {
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];

  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error(`Invalid base32 character: ${character}`);
    }

    current = (current << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
