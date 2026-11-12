/** Minimum ifa-0001 import recursion degree supported by the resolver. */
export const DEFAULT_MAX_IMPORT_DEPTH = 4;

export type NamecoinValueFetcher = (
  namecoinName: string,
) => Promise<string | undefined | null>;

interface ImportOp {
  name: string;
  selector: string;
}

type JsonRecord = Record<string, unknown>;

type ImportState = {
  fetcher: NamecoinValueFetcher;
  maxDepth: number;
  activeNames: Set<string>;
};

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseObject(raw: string, name: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed JSON in Namecoin import ${name}`, {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Namecoin import ${name} is not a Domain Name Object`);
  }
  return parsed;
}

function removeImportKey(obj: JsonRecord): JsonRecord {
  if (!hasOwn(obj, "import")) return obj;
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key !== "import") out[key] = value;
  }
  return out;
}

/** Earlier objects win, including explicit null values. */
function mergeByPrecedence(
  higher: JsonRecord,
  lower: JsonRecord,
): JsonRecord {
  return { ...lower, ...higher };
}

function opFromArray(arr: unknown[]): ImportOp {
  if (arr.length === 0 || typeof arr[0] !== "string") {
    throw new Error("Invalid Namecoin import operation");
  }
  const name = arr[0].trim();
  if (!name) throw new Error("Empty Namecoin import name");
  let selector = "";
  if (arr.length >= 2) {
    if (typeof arr[1] !== "string") {
      throw new Error("Invalid Namecoin import subdomain selector");
    }
    selector = arr[1].trim();
  }
  if (selector.endsWith(".")) {
    throw new Error("Namecoin import selector must not end in a dot");
  }
  return { name, selector };
}

/** Parse the three distinct ifa-0001 import forms. */
function parseImportItem(item: unknown): ImportOp[] {
  if (typeof item === "string") return [opFromArray([item])];
  if (!Array.isArray(item)) throw new Error("Invalid Namecoin import item");
  if (item.length === 0) return [];

  if (item.every((entry) => typeof entry === "string")) {
    return item.map((name) => opFromArray([name]));
  }
  if (item.every((entry) => Array.isArray(entry))) {
    return item.map((entry) => opFromArray(entry as unknown[]));
  }
  throw new Error("Mixed Namecoin import forms are invalid");
}

function normalizeMapChild(value: unknown): JsonRecord {
  if (typeof value === "string") return { ip: [value] };
  if (!isPlainObject(value)) {
    throw new Error("Namecoin map child is not a Domain Name Object");
  }
  return value;
}

function selectorLabels(selector: string): string[] {
  if (!selector) return [];
  const labels = selector.split(".");
  if (labels.some((label) => !label)) {
    throw new Error("Namecoin selector contains an empty label");
  }
  return labels.reverse();
}

async function expandObject(
  obj: JsonRecord,
  state: ImportState,
  degree: number,
): Promise<JsonRecord> {
  let current = removeImportKey(obj);

  if (hasOwn(obj, "import") && obj.import !== undefined) {
    const operations = parseImportItem(obj.import);
    if (degree + operations.length > state.maxDepth) {
      throw new Error("Namecoin import recursion degree exceeded");
    }

    let importedValues: JsonRecord = {};
    let firstFailure: unknown;
    for (const op of operations) {
      if (state.activeNames.has(op.name)) {
        firstFailure ??= new Error(`Namecoin import cycle at ${op.name}`);
        continue;
      }

      state.activeNames.add(op.name);
      try {
        const raw = await state.fetcher(op.name);
        if (!raw) throw new Error(`Namecoin import ${op.name} is unavailable`);
        const importedRoot = parseObject(raw, op.name);
        const expanded = await expandObject(
          importedRoot,
          state,
          degree + operations.length,
        );
        const selected = await selectLabels(
          expanded,
          selectorLabels(op.selector),
          state,
        );
        importedValues = mergeByPrecedence(importedValues, selected);
      } catch (error) {
        firstFailure ??= error;
      } finally {
        state.activeNames.delete(op.name);
      }
    }
    if (firstFailure) throw firstFailure;
    current = mergeByPrecedence(current, importedValues);
  }

  // map[""] supplies defaults to its immediate parent. It is never a child
  // candidate during subdomain selection.
  const map = current.map;
  if (isPlainObject(map) && hasOwn(map, "")) {
    const defaults = normalizeMapChild(map[""]);
    const expandedDefaults = await expandObject(defaults, state, 0);
    current = mergeByPrecedence(current, expandedDefaults);
  }

  return current;
}

async function selectLabels(
  root: JsonRecord,
  labels: string[],
  state: ImportState,
): Promise<JsonRecord> {
  let current = root;
  for (const label of labels) {
    const map = current.map;
    if (!isPlainObject(map)) {
      throw new Error(`Namecoin map does not contain ${label}`);
    }
    const child = hasOwn(map, label)
      ? map[label]
      : hasOwn(map, "*")
      ? map["*"]
      : undefined;
    if (child === undefined) {
      throw new Error(`Namecoin map does not contain ${label}`);
    }
    current = await expandObject(normalizeMapChild(child), state, 0);
  }
  return current;
}

/** Expand the imports and parent defaults on one Domain Name Object. */
export async function expandImports(
  root: JsonRecord,
  fetcher: NamecoinValueFetcher,
  maxDepth: number = DEFAULT_MAX_IMPORT_DEPTH,
): Promise<JsonRecord> {
  return await expandObject(root, {
    fetcher,
    maxDepth,
    activeNames: new Set<string>(),
  }, 0);
}

/** Expand a root and walk host subdomain labels in right-to-left DNS order. */
export async function resolveNamecoinNode(
  root: JsonRecord,
  subdomains: string[],
  fetcher: NamecoinValueFetcher,
  maxDepth: number = DEFAULT_MAX_IMPORT_DEPTH,
): Promise<JsonRecord> {
  const state: ImportState = {
    fetcher,
    maxDepth,
    activeNames: new Set<string>(),
  };
  const expanded = await expandObject(root, state, 0);
  return await selectLabels(expanded, [...subdomains].reverse(), state);
}
