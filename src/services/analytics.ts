import { cache } from "./cache.ts";

/** Increment the hit counter for a site. Fire-and-forget safe. */
export async function incrementHitCount(
  pubkey: string,
  identifier: string,
) {
  await cache
    .atomic()
    .sum(["analytics", pubkey, identifier], 1n)
    .commit();
}

/** Get the total hit count for a site. */
export async function getHitCount(
  pubkey: string,
  identifier: string,
): Promise<number> {
  const entry = await cache.get<Deno.KvU64>(["analytics", pubkey, identifier]);
  return entry.value ? Number(entry.value) : 0;
}
