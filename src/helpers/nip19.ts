import { bech32 } from "@scure/base";

export type StrictNip19Pointer =
  | { type: "npub"; data: string }
  | {
    type: "nprofile";
    data: { pubkey: string; relays: string[] };
  }
  | {
    type: "naddr";
    data: {
      identifier: string;
      pubkey: string;
      kind: number;
      relays: string[];
    };
  }
  | {
    type: "nevent";
    data: {
      id: string;
      relays: string[];
      author?: string;
      kind?: number;
    };
  }
  | { type: "note"; data: string };

type TlvMap = Map<number, Uint8Array[]>;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseTlv(bytes: Uint8Array): TlvMap {
  const tlv: TlvMap = new Map();
  let offset = 0;

  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new Error("Truncated TLV header");
    const type = bytes[offset];
    const length = bytes[offset + 1];
    offset += 2;
    if (offset + length > bytes.length) throw new Error("Truncated TLV value");
    const value = bytes.slice(offset, offset + length);
    offset += length;
    const values = tlv.get(type) ?? [];
    values.push(value);
    tlv.set(type, values);
  }

  return tlv;
}

function requiredSingleton(
  tlv: TlvMap,
  type: number,
  length?: number,
): Uint8Array {
  const values = tlv.get(type);
  if (!values || values.length !== 1) {
    throw new Error(`Expected exactly one TLV ${type}`);
  }
  if (length !== undefined && values[0].length !== length) {
    throw new Error(`Invalid TLV ${type} length`);
  }
  return values[0];
}

function optionalSingleton(
  tlv: TlvMap,
  type: number,
  length: number,
): Uint8Array | undefined {
  const values = tlv.get(type);
  if (!values) return undefined;
  if (values.length !== 1 || values[0].length !== length) {
    throw new Error(`Invalid TLV ${type} cardinality or length`);
  }
  return values[0];
}

function decodeKind(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

function decodeRelays(tlv: TlvMap): string[] {
  return (tlv.get(1) ?? []).map((bytes) => {
    if (bytes.some((byte) => byte > 0x7f)) {
      throw new Error("Relay URL must be ASCII");
    }
    const relay = new TextDecoder().decode(bytes);
    let url: URL;
    try {
      url = new URL(relay);
    } catch {
      throw new Error("Invalid relay URL");
    }
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") || !url.hostname
    ) {
      throw new Error("Invalid WebSocket relay URL");
    }
    return relay;
  });
}

/** Decode the strict lowercase NIP-19 profile required for Namecoin nsites. */
export function decodeNsitePointer(value: string): StrictNip19Pointer {
  if (value !== value.toLowerCase()) {
    throw new Error("NIP-19 entities must be canonical lowercase");
  }

  const decoded = bech32.decode(value as `${string}1${string}`, 5000);
  const bytes = new Uint8Array(bech32.fromWords(decoded.words));

  if (decoded.prefix === "npub" || decoded.prefix === "note") {
    if (bytes.length !== 32) throw new Error("Expected a 32-byte identifier");
    return { type: decoded.prefix, data: toHex(bytes) };
  }

  const tlv = parseTlv(bytes);
  if (decoded.prefix === "nprofile") {
    const pubkey = requiredSingleton(tlv, 0, 32);
    return {
      type: "nprofile",
      data: { pubkey: toHex(pubkey), relays: decodeRelays(tlv) },
    };
  }

  if (decoded.prefix === "nevent") {
    const id = requiredSingleton(tlv, 0, 32);
    const author = optionalSingleton(tlv, 2, 32);
    const kind = optionalSingleton(tlv, 3, 4);
    return {
      type: "nevent",
      data: {
        id: toHex(id),
        relays: decodeRelays(tlv),
        ...(author ? { author: toHex(author) } : {}),
        ...(kind ? { kind: decodeKind(kind) } : {}),
      },
    };
  }

  if (decoded.prefix === "naddr") {
    const identifier = requiredSingleton(tlv, 0);
    const author = requiredSingleton(tlv, 2, 32);
    const kind = requiredSingleton(tlv, 3, 4);
    return {
      type: "naddr",
      data: {
        identifier: new TextDecoder("utf-8", { fatal: true }).decode(
          identifier,
        ),
        pubkey: toHex(author),
        kind: decodeKind(kind),
        relays: decodeRelays(tlv),
      },
    };
  }

  throw new Error(`Unsupported NIP-19 entity: ${decoded.prefix}`);
}
