/**
 * Resolves the `import` item of a Namecoin Domain Name Object, recursively
 * merging values from imported names into the importing object before the
 * caller extracts fields like `nostr`.
 *
 * Per ifa-0001 §"import" (https://github.com/namecoin/proposals/blob/master/ifa-0001.md):
 *
 *  - The importing object's items take precedence over imported items. A
 *    `null` value in the importer is still considered "present" and so
 *    nullifies the corresponding imported item (semantic suppression).
 *  - The `import` value is an array of arrays. Each inner array has at
 *    least one element (the name to import, e.g. `d/example2`) and an
 *    optional second element, a Subdomain Selector (DNS-format, dotted).
 *    Selector labels are resolved against the imported value's `map` tree
 *    before merging.
 *  - Three shorthand forms are accepted in addition to the canonical
 *    array-of-arrays. They appear frequently in real-world records:
 *      - `"import": "d/foo"`            ↔  `[["d/foo"]]`
 *      - `"import": ["d/foo"]`          ↔  `[["d/foo"]]`
 *      - `"import": ["d/foo","sub"]`    ↔  `[["d/foo","sub"]]`
 *  - Recursion: the spec mandates implementations support a recursion
 *    depth of at least four. We default to that limit; deeper chains are
 *    silently truncated (the importing object's own items still apply).
 *  - Cycles are broken by a visited-set keyed on `name|selector`.
 *  - Merge is shallow per spec: a key in the importer replaces the
 *    imported value wholesale; nested objects are not merged recursively.
 *  - A failed lookup (name not found, malformed JSON, network error) MAY
 *    cause the whole importing record to fail per spec. To preserve the
 *    existing best-effort behaviour (transient ElectrumX hiccups should
 *    not kill resolution), this implementation treats a failed import as
 *    if the imported value were the empty object `{}`.
 */

/** Minimum recursion depth ifa-0001 requires implementations to support. */
export const DEFAULT_MAX_IMPORT_DEPTH = 4;

/**
 * Async name lookup callback. Returns the raw value JSON string of the
 * named record, or `undefined`/`null` if the name does not exist, is
 * expired, or could not be fetched. Failures are absorbed by the
 * resolver: a throw is equivalent to returning `undefined`.
 */
export type NamecoinValueFetcher = (
  namecoinName: string,
) => Promise<string | undefined | null>;

interface ImportOp {
  name: string;
  /** DNS-dotted selector, may be empty. Preserved as written. */
  selector: string;
}

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParseObject(raw: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function removeImportKey(obj: JsonRecord): JsonRecord {
  if (!("import" in obj)) return obj;
  const out: JsonRecord = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "import") out[k] = v;
  }
  return out;
}

/**
 * Merge with importer-wins semantics: every key in `importer` stays as-is
 * (including `null`, which suppresses the imported counterpart per spec);
 * keys present only in `imported` are added.
 */
function mergeImporterWins(
  importer: JsonRecord,
  imported: JsonRecord,
): JsonRecord {
  const importerKeys = Object.keys(importer);
  if (importerKeys.length === 0) return imported;
  const importedKeys = Object.keys(imported);
  if (importedKeys.length === 0) return importer;
  const out: JsonRecord = {};
  for (const k of importedKeys) out[k] = imported[k];
  for (const k of importerKeys) out[k] = importer[k];
  return out;
}

/**
 * Walk the imported object's `map` tree to the node addressed by
 * `selector` (DNS dotted, e.g. `relay`, `a.b.c`). Empty selector returns
 * the root unchanged.
 *
 * Per ifa-0001 §"map":
 *   - Exact label match wins.
 *   - Wildcard `*` matches any single label.
 *   - Empty key `""` is the default for the current level when nothing
 *     else matches.
 *   - A non-object child terminates the walk with `undefined`.
 *
 * The `map` tree nests from the parent inwards toward the leaf, so the
 * selector is walked right-to-left (rightmost label is the immediate
 * child of the parent's `map`).
 */
function applySelector(
  root: JsonRecord,
  selector: string,
): JsonRecord | undefined {
  if (selector.length === 0) return root;
  const labels = selector.split(".").filter((s) => s.length > 0).reverse();
  if (labels.length === 0) return root;

  let current: JsonRecord = root;
  for (const label of labels) {
    const map = current["map"];
    if (!isPlainObject(map)) return undefined;
    const exact = map[label];
    const wildcard = map["*"];
    const fallback = map[""];
    const child = isPlainObject(exact)
      ? exact
      : isPlainObject(wildcard)
      ? wildcard
      : isPlainObject(fallback)
      ? fallback
      : undefined;
    if (!child) return undefined;
    current = child;
  }
  return current;
}

function opFromArray(arr: unknown[]): ImportOp | undefined {
  if (arr.length === 0) return undefined;
  const first = arr[0];
  if (typeof first !== "string") return undefined;
  const name = first.trim();
  if (name.length === 0) return undefined;
  let selector = "";
  if (arr.length >= 2) {
    const second = arr[1];
    if (typeof second !== "string") return undefined;
    selector = second.trim();
  }
  // Trailing dot is forbidden by spec; treat as malformed → no selector.
  if (selector.endsWith(".")) return undefined;
  return { name, selector };
}

/**
 * Parse the value of an `import` item into a list of {@link ImportOp}
 * descriptors. Returns `undefined` if the value is malformed.
 *
 * Accepted shapes (in order of preference):
 *   - canonical: `[ ["d/foo"], ["d/bar","sub"] ]`
 *   - bare string shorthand: `"d/foo"` → one op with no selector
 *   - single-element array shorthand: `["d/foo"]` → one op with no selector
 *   - pair-array shorthand: `["d/foo","sub"]` → one op with selector
 *
 * Anything else is treated as malformed and the import is skipped.
 */
function parseImportItem(item: unknown): ImportOp[] | undefined {
  if (typeof item === "string") {
    const name = item.trim();
    if (name.length === 0) return undefined;
    return [{ name, selector: "" }];
  }
  if (!Array.isArray(item)) return undefined;
  if (item.length === 0) return [];

  // Distinguish array-of-arrays (canonical) vs array-of-strings (shorthand).
  if (Array.isArray(item[0])) {
    const ops: ImportOp[] = [];
    for (const entry of item) {
      if (!Array.isArray(entry)) continue; // skip malformed inner entries
      const op = opFromArray(entry);
      if (op) ops.push(op);
    }
    return ops;
  }
  const op = opFromArray(item);
  return op ? [op] : [];
}

async function expandRecursive(
  obj: JsonRecord,
  fetcher: NamecoinValueFetcher,
  budgetRemaining: number,
  visited: Set<string>,
): Promise<JsonRecord> {
  const importItem = obj["import"];
  if (importItem === undefined) return obj;

  const operations = parseImportItem(importItem);
  if (!operations || operations.length === 0 || budgetRemaining <= 0) {
    return removeImportKey(obj);
  }

  // Walk imports left-to-right. The spec is silent on multi-import
  // precedence; we follow the common-sense rule that LATER imports
  // override EARLIER ones in the same array (otherwise listing two
  // libraries would silently ignore the second). The accumulator still
  // loses to the importing object on top of all of it.
  let accumulator: JsonRecord = {};
  for (const op of operations) {
    const visitKey = `${op.name}|${op.selector}`;
    if (visited.has(visitKey)) continue; // cycle / duplicate within this chain
    visited.add(visitKey);
    try {
      let importedRaw: string | undefined | null;
      try {
        importedRaw = await fetcher(op.name);
      } catch {
        importedRaw = undefined;
      }
      if (!importedRaw) continue;
      const importedRoot = tryParseObject(importedRaw);
      if (!importedRoot) continue;
      const selectorView = applySelector(importedRoot, op.selector);
      if (!selectorView) continue;
      const expanded = await expandRecursive(
        selectorView,
        fetcher,
        budgetRemaining - 1,
        visited,
      );
      accumulator = mergeImporterWins(expanded, accumulator);
    } finally {
      visited.delete(visitKey);
    }
  }

  const withoutImport = removeImportKey(obj);
  return mergeImporterWins(withoutImport, accumulator);
}

/**
 * Expand all `import` items in `root` (and recursively in imported
 * objects) up to `maxDepth` levels deep, returning a single merged
 * object with no `import` key.
 *
 * The merged object preserves the importing object's items unchanged;
 * imported items only fill keys the importing object did not declare
 * (including keys whose value is `null` — those remain suppressed).
 *
 * If `root` has no `import` key, it is returned unchanged and the
 * fetcher is never called. This keeps non-import records at zero extra
 * I/O cost.
 */
export async function expandImports(
  root: JsonRecord,
  fetcher: NamecoinValueFetcher,
  maxDepth: number = DEFAULT_MAX_IMPORT_DEPTH,
): Promise<JsonRecord> {
  if (!isPlainObject(root)) return root;
  if (!("import" in root)) return root;
  return await expandRecursive(root, fetcher, maxDepth, new Set<string>());
}
