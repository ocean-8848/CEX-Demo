import assert from "node:assert/strict";
import test from "node:test";

import { decodeQrBytes, encodeQr, qrToSvgPath, type QrMatrix } from "../client/lib/qr.js";

// ISO/IEC 18004 Table C.1: 15-bit format information for error level M.
const FORMAT_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000"
];

function readFormatBits(matrix: QrMatrix): string {
  const m = matrix.modules;
  // First copy, bit 14 (MSB) ... bit 0, following the placement in drawFormatBits.
  const bits: boolean[] = new Array(15);
  for (let i = 0; i <= 5; i += 1) bits[i] = m[i]![8]!;
  bits[6] = m[7]![8]!;
  bits[7] = m[8]![8]!;
  bits[8] = m[8]![7]!;
  for (let i = 9; i < 15; i += 1) bits[i] = m[8]![14 - i]!;
  return bits.map((bit) => (bit ? "1" : "0")).reverse().join("");
}

function assertFinder(matrix: QrMatrix, x0: number, y0: number) {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(matrix.modules[y0 + dy]![x0 + dx], ring !== 2, `finder module ${x0 + dx},${y0 + dy}`);
    }
  }
}

test("QR encoder produces a valid, decodable otpauth code", () => {
  const uri =
    "otpauth://totp/Web3%20CEX:demo-trader%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Web3%20CEX&digits=6&period=30";
  const matrix = encodeQr(uri, "M");

  assert.equal(matrix.size, matrix.version * 4 + 17);
  assert.ok(matrix.version >= 6 && matrix.version <= 9, `unexpected version ${matrix.version}`);
  assertFinder(matrix, 0, 0);
  assertFinder(matrix, matrix.size - 7, 0);
  assertFinder(matrix, 0, matrix.size - 7);
  for (let i = 8; i < matrix.size - 8; i += 1) {
    assert.equal(matrix.modules[6]![i], i % 2 === 0, "horizontal timing pattern");
    assert.equal(matrix.modules[i]![6], i % 2 === 0, "vertical timing pattern");
  }
  assert.equal(matrix.modules[matrix.size - 8]![8], true, "dark module");
  assert.equal(readFormatBits(matrix), FORMAT_M[matrix.mask]);

  const decoded = decodeQrBytes(matrix, "M");
  assert.equal(decoded.formatValid, true);
  assert.equal(decoded.eccValid, true);
  assert.equal(decoded.text, uri);
});

test("QR encoder round-trips across versions, levels and UTF-8", () => {
  const samples = ["a", "Hello, world! 123", "二次验证 · 恢复码", "x".repeat(300), "y".repeat(1200)];
  for (const level of ["L", "M", "Q", "H"] as const) {
    for (const sample of samples) {
      const matrix = encodeQr(sample, level);
      const decoded = decodeQrBytes(matrix, level);
      assert.equal(decoded.text, sample, `${level} ${sample.length}`);
      assert.equal(decoded.eccValid, true);
      assert.equal(decoded.formatValid, true);
    }
  }
  assert.equal(encodeQr("a", "M").version, 1);
  assert.ok(encodeQr("y".repeat(1200), "M").version >= 27, "16-bit count versions are covered");
  assert.throws(() => encodeQr("z".repeat(4000), "H"), /too long/);
});

test("QR SVG path draws one square per dark module inside the quiet zone", () => {
  const matrix = encodeQr("otpauth://totp/x?secret=ABC", "M");
  const path = qrToSvgPath(matrix, 4);
  const darkCount = matrix.modules.flat().filter(Boolean).length;
  assert.equal((path.match(/M/g) ?? []).length, darkCount);
  assert.ok(path.startsWith("M4,4h1v1h-1z"), "top-left finder corner sits at the border offset");
});
