import { assertEquals, assertThrows } from "jsr:@std/assert";
import { bech32 } from "@scure/base";
import { naddrEncode, npubEncode } from "applesauce-core/helpers";
import { decodeNsitePointer } from "../nip19.ts";

const PK = "460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c";
const ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/.{2}/g) ?? [],
    (pair) => parseInt(pair, 16),
  );
}

function encode(prefix: string, data: Uint8Array): string {
  return bech32.encode(
    prefix,
    bech32.toWords(data),
    5000,
  );
}

function tlv(type: number, values: Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length + 2, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result[offset++] = type;
    result[offset++] = value.length;
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function kindBytes(kind: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, kind, false);
  return result;
}

Deno.test("strict NIP-19 decoder accepts root and named naddr coordinates", () => {
  assertEquals(
    decodeNsitePointer(
      naddrEncode({ pubkey: PK, identifier: "", kind: 15128 }),
    ),
    {
      type: "naddr",
      data: { pubkey: PK, identifier: "", kind: 15128, relays: [] },
    },
  );
  assertEquals(
    decodeNsitePointer(
      naddrEncode({ pubkey: PK, identifier: "Blog_v2", kind: 35128 }),
    ).data,
    { pubkey: PK, identifier: "Blog_v2", kind: 35128, relays: [] },
  );
});

Deno.test("strict NIP-19 decoder rejects uppercase entities", () => {
  assertThrows(() => decodeNsitePointer(npubEncode(PK).toUpperCase()));
});

Deno.test("strict NIP-19 decoder requires 32-byte npub and note values", () => {
  assertThrows(() => decodeNsitePointer(encode("npub", new Uint8Array(31))));
  assertThrows(() => decodeNsitePointer(encode("note", new Uint8Array(33))));
  assertEquals(decodeNsitePointer(encode("note", bytes(ID))).data, ID);
});

Deno.test("strict NIP-19 decoder rejects duplicate and missing nprofile special TLVs", () => {
  const special = tlv(0, [bytes(PK)]);
  assertThrows(() =>
    decodeNsitePointer(encode("nprofile", concat(special, special)))
  );
  assertThrows(() => decodeNsitePointer(encode("nprofile", new Uint8Array())));
  assertThrows(() =>
    decodeNsitePointer(encode("nprofile", tlv(0, [new Uint8Array(31)])))
  );
});

Deno.test("strict NIP-19 decoder rejects duplicate nevent singleton TLVs", () => {
  const id = tlv(0, [bytes(ID)]);
  const author = tlv(2, [bytes(PK)]);
  const kind = tlv(3, [kindBytes(15128)]);
  for (
    const data of [
      concat(id, id),
      concat(id, author, author),
      concat(id, kind, kind),
    ]
  ) {
    assertThrows(() => decodeNsitePointer(encode("nevent", data)));
  }
});

Deno.test("strict NIP-19 decoder rejects invalid nevent hint lengths", () => {
  const id = tlv(0, [bytes(ID)]);
  assertThrows(() =>
    decodeNsitePointer(
      encode("nevent", concat(id, tlv(2, [new Uint8Array(31)]))),
    )
  );
  assertThrows(() =>
    decodeNsitePointer(
      encode("nevent", concat(id, tlv(3, [new Uint8Array(3)]))),
    )
  );
});

Deno.test("strict NIP-19 decoder rejects duplicate naddr singleton TLVs", () => {
  const identifier = tlv(0, [new TextEncoder().encode("blog")]);
  const author = tlv(2, [bytes(PK)]);
  const kind = tlv(3, [kindBytes(35128)]);
  for (
    const data of [
      concat(identifier, identifier, author, kind),
      concat(identifier, author, author, kind),
      concat(identifier, author, kind, kind),
    ]
  ) {
    assertThrows(() => decodeNsitePointer(encode("naddr", data)));
  }
});

Deno.test("strict NIP-19 decoder rejects missing naddr fields and invalid UTF-8", () => {
  const identifier = tlv(0, [new TextEncoder().encode("blog")]);
  const author = tlv(2, [bytes(PK)]);
  const kind = tlv(3, [kindBytes(35128)]);
  assertThrows(() =>
    decodeNsitePointer(encode("naddr", concat(identifier, author)))
  );
  assertThrows(() =>
    decodeNsitePointer(
      encode("naddr", concat(tlv(0, [new Uint8Array([0xff])]), author, kind)),
    )
  );
});

Deno.test("strict NIP-19 decoder rejects truncated TLVs", () => {
  assertThrows(() =>
    decodeNsitePointer(encode("nprofile", new Uint8Array([0])))
  );
  assertThrows(() =>
    decodeNsitePointer(encode("nprofile", new Uint8Array([0, 32, 1, 2])))
  );
});

Deno.test("strict NIP-19 decoder validates every relay TLV", () => {
  const special = tlv(0, [bytes(PK)]);
  const valid = new TextEncoder().encode("wss://relay.example.com");
  const repeated = tlv(1, [valid, valid]);
  const unknown = tlv(9, [new Uint8Array([1, 2, 3])]);
  assertEquals(
    decodeNsitePointer(encode("nprofile", concat(special, repeated, unknown))),
    {
      type: "nprofile",
      data: {
        pubkey: PK,
        relays: ["wss://relay.example.com", "wss://relay.example.com"],
      },
    },
  );
  assertThrows(() =>
    decodeNsitePointer(
      encode(
        "nprofile",
        concat(
          special,
          tlv(1, [new TextEncoder().encode("https://example.com")]),
        ),
      ),
    )
  );
  assertThrows(() =>
    decodeNsitePointer(
      encode(
        "nprofile",
        concat(special, tlv(1, [new Uint8Array([0xff])])),
      ),
    )
  );
});
