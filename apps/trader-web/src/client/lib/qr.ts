/**
 * Minimal, dependency-free QR Code encoder (byte mode only), used to render the
 * TOTP `otpauth://` URI on the account page. It follows ISO/IEC 18004
 * and the well-known reference implementation by Project Nayuki (MIT):
 * Reed-Solomon ECC over GF(256), block interleaving, the 8 data masks with the
 * standard penalty rules, and BCH-coded format / version information.
 *
 * Kept small on purpose: no Kanji / alphanumeric segment optimisation — an
 * otpauth URI is ~120 bytes, which fits comfortably in version 6-8 at level M.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  version: number;
  size: number;
  /** modules[y][x] === true means a dark module. */
  modules: boolean[][];
  mask: number;
}

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// Index 0 is padding; rows are L, M, Q, H; columns are versions 1..40.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Encodes `text` (UTF-8) into a QR matrix using the smallest version that fits. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
  const data = Array.from(new TextEncoder().encode(text));

  let version = 1;
  let dataCapacityBits = 0;
  for (; version <= 40; version += 1) {
    dataCapacityBits = getNumDataCodewords(version, ecc) * 8;
    const usedBits = 4 + (version <= 9 ? 8 : 16) + data.length * 8;
    if (usedBits <= dataCapacityBits) {
      break;
    }
  }
  if (version > 40) {
    throw new RangeError("Data too long for a QR code");
  }

  // Byte-mode segment + terminator + bit padding + pad bytes.
  const bits: number[] = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, data.length, version <= 9 ? 8 : 16);
  for (const byte of data) {
    appendBits(bits, byte, 8);
  }
  appendBits(bits, 0, Math.min(4, dataCapacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  const dataCodewords: number[] = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, index) => {
    dataCodewords[index >>> 3] = (dataCodewords[index >>> 3] ?? 0) | (bit << (7 - (index & 7)));
  });

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  drawFunctionPatterns(version, size, setFunction);
  drawFormatBits(ecc, 0, size, setFunction); // placeholder, redrawn after masking
  drawCodewords(allCodewords, size, modules, isFunction);

  let bestMask = 0;
  let minPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask, size, modules, isFunction);
    drawFormatBits(ecc, mask, size, setFunction);
    const penalty = getPenaltyScore(size, modules);
    if (penalty < minPenalty) {
      bestMask = mask;
      minPenalty = penalty;
    }
    applyMask(mask, size, modules, isFunction); // XOR again to undo
  }
  applyMask(bestMask, size, modules, isFunction);
  drawFormatBits(ecc, bestMask, size, setFunction);

  return { version, size, modules, mask: bestMask };
}

/** Renders the matrix as an SVG path string (one 1x1 square per dark module). */
export function qrToSvgPath(matrix: QrMatrix, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y]![x]) {
        parts.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
  }
  return parts.join("");
}

/**
 * Reads a matrix produced by `encodeQr` back into text and checks every
 * Reed-Solomon block. Only used by tests as a round-trip self-check; esbuild
 * drops it from the client bundle because nothing in the UI imports it.
 */
export function decodeQrBytes(matrix: QrMatrix, ecc: QrEcc = "M"): { text: string; eccValid: boolean; formatValid: boolean } {
  const { version, size } = matrix;
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const expectedFormat: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number, dark: boolean) => {
    isFunction[y]![x] = true;
    expectedFormat[y]![x] = dark;
  };
  drawFunctionPatterns(version, size, mark);
  drawFormatBits(ecc, matrix.mask, size, mark);

  let formatValid = true;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y]![x] && expectedFormat[y]![x] !== matrix.modules[y]![x]) {
        formatValid = false;
      }
    }
  }

  const unmasked = matrix.modules.map((row) => [...row]);
  applyMask(matrix.mask, size, unmasked, isFunction);

  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const codewords: number[] = new Array(rawCodewords).fill(0);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIndex < rawCodewords * 8) {
          if (unmasked[y]![x]) {
            codewords[bitIndex >>> 3] = (codewords[bitIndex >>> 3] ?? 0) | (1 << (7 - (bitIndex & 7)));
          }
          bitIndex += 1;
        }
      }
    }
  }

  const row = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[row]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[row]![version]!;
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortBlockLen + 1; i += 1) {
    for (let j = 0; j < numBlocks; j += 1) {
      // Short blocks carry a padding slot after their data (see addEccAndInterleave).
      if (i === shortBlockLen - blockEccLen && j < numShortBlocks) {
        continue;
      }
      blocks[j]!.push(codewords[k]!);
      k += 1;
    }
  }

  const divisor = reedSolomonComputeDivisor(blockEccLen);
  let eccValid = true;
  const data: number[] = [];
  for (const block of blocks) {
    const dataPart = block.slice(0, block.length - blockEccLen);
    const eccPart = block.slice(block.length - blockEccLen);
    const expected = reedSolomonComputeRemainder(dataPart, divisor);
    if (expected.some((value, index) => value !== eccPart[index])) {
      eccValid = false;
    }
    data.push(...dataPart);
  }

  const bits: number[] = [];
  for (const byte of data) {
    appendBits(bits, byte, 8);
  }
  const readBits = (offset: number, length: number) =>
    bits.slice(offset, offset + length).reduce((value, bit) => (value << 1) | bit, 0);
  const mode = readBits(0, 4);
  const countBits = version <= 9 ? 8 : 16;
  const count = readBits(4, countBits);
  const bytes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    bytes.push(readBits(4 + countBits + i * 8, 8));
  }
  return {
    text: mode === 0x4 ? new TextDecoder().decode(new Uint8Array(bytes)) : "",
    eccValid,
    formatValid
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function appendBits(target: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) {
    target.push((value >>> i) & 1);
  }
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

function getNumDataCodewords(version: number, ecc: QrEcc): number {
  const row = ECC_ORDINAL[ecc];
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[row]![version]! * NUM_ERROR_CORRECTION_BLOCKS[row]![version]!
  );
}

function addEccAndInterleave(data: number[], version: number, ecc: QrEcc): number[] {
  const row = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[row]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[row]![version]!;
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = reedSolomonComputeDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + dataLen);
    k += dataLen;
    const eccBytes = reedSolomonComputeRemainder(dat, divisor);
    if (i < numShortBlocks) {
      dat.push(0);
    }
    blocks.push(dat.concat(eccBytes));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]!);
      }
    });
  }
  return result;
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = reedSolomonMultiply(result[j]!, root);
      if (j + 1 < result.length) {
        result[j] = (result[j] ?? 0) ^ result[j + 1]!;
      }
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ reedSolomonMultiply(coef, factor);
    });
  }
  return result;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function getAlignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) {
    return [];
  }
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function drawFunctionPatterns(
  version: number,
  size: number,
  setFunction: (x: number, y: number, dark: boolean) => void
): void {
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  const drawFinder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const positions = getAlignmentPatternPositions(version, size);
  const count = positions.length;
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(positions[i]! + dx, positions[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }
}

function drawFormatBits(
  ecc: QrEcc,
  mask: number,
  size: number,
  setFunction: (x: number, y: number, dark: boolean) => void
): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) {
    setFunction(8, i, getBit(bits, i));
  }
  setFunction(8, 7, getBit(bits, 6));
  setFunction(8, 8, getBit(bits, 7));
  setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) {
    setFunction(14 - i, 8, getBit(bits, i));
  }

  for (let i = 0; i < 8; i += 1) {
    setFunction(size - 1 - i, 8, getBit(bits, i));
  }
  for (let i = 8; i < 15; i += 1) {
    setFunction(8, size - 15 + i, getBit(bits, i));
  }
  setFunction(8, size - 8, true); // dark module
}

function drawCodewords(
  data: number[],
  size: number,
  modules: boolean[][],
  isFunction: boolean[][]
): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && i < data.length * 8) {
          modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

function applyMask(mask: number, size: number, modules: boolean[][], isFunction: boolean[][]): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (!isFunction[y]![x] && invert) {
        modules[y]![x] = !modules[y]![x];
      }
    }
  }
}

function getPenaltyScore(size: number, modules: boolean[][]): number {
  let result = 0;

  const scanLine = (get: (i: number) => boolean) => {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i += 1) {
      if (get(i) === runColor) {
        runLength += 1;
        if (runLength === 5) {
          result += PENALTY_N1;
        } else if (runLength > 5) {
          result += 1;
        }
      } else {
        finderPenaltyAddHistory(runLength, history, size);
        if (!runColor) {
          result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        }
        runColor = get(i);
        runLength = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLength, history, size) * PENALTY_N3;
  };

  for (let y = 0; y < size; y += 1) {
    scanLine((x) => modules[y]![x]!);
  }
  for (let x = 0; x < size; x += 1) {
    scanLine((y) => modules[y]![x]!);
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y]![x];
      if (color === modules[y]![x + 1] && color === modules[y + 1]![x] && color === modules[y + 1]![x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) {
    dark = row.reduce((sum, cell) => sum + (cell ? 1 : 0), dark);
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

function finderPenaltyCountPatterns(history: number[]): number {
  const n = history[1]!;
  const core =
    n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (
    (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
    (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
  );
}

function finderPenaltyTerminateAndCount(
  currentRunColor: boolean,
  currentRunLength: number,
  history: number[],
  size: number
): number {
  let runLength = currentRunLength;
  if (currentRunColor) {
    finderPenaltyAddHistory(runLength, history, size);
    runLength = 0;
  }
  runLength += size;
  finderPenaltyAddHistory(runLength, history, size);
  return finderPenaltyCountPatterns(history);
}

function finderPenaltyAddHistory(currentRunLength: number, history: number[], size: number): void {
  let runLength = currentRunLength;
  if (history[0] === 0) {
    runLength += size; // light border before the first run
  }
  history.pop();
  history.unshift(runLength);
}
