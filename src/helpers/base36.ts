const CANONICAL_B36_LENGTH = 50;
const MAX_32_BYTE_VALUE = (1n << 256n) - 1n;

function base36Digit(char: string): bigint | undefined {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return BigInt(code - 48);
  if (code >= 97 && code <= 122) return BigInt(code - 87);
  return undefined;
}

export function decodeHex32B36(valueB36: string): string | undefined {
  if (!/^[0-9a-z]{50}$/.test(valueB36)) return undefined;

  let value = 0n;
  for (const char of valueB36) {
    const digit = base36Digit(char);
    if (digit === undefined) return undefined;
    value = value * 36n + digit;
    if (value > MAX_32_BYTE_VALUE) return undefined;
  }

  return value.toString(16).padStart(64, "0");
}

export function encodeHex32B36(hex: string): string | undefined {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return undefined;

  const value = BigInt(`0x${hex}`);
  if (value > MAX_32_BYTE_VALUE) return undefined;
  return value.toString(36).padStart(CANONICAL_B36_LENGTH, "0");
}
