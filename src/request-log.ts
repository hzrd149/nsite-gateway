export type RequestLogField = string | number | boolean;

export type RequestLogState = {
  outcome?: string;
  fields: Record<string, RequestLogField>;
  errors: Array<{
    message: string;
    fields: Record<string, RequestLogField>;
  }>;
};

export type RequestLog = {
  setOutcome: (
    outcome: string,
    fields?: Record<string, RequestLogField | undefined>,
  ) => void;
  addFields: (fields: Record<string, RequestLogField | undefined>) => void;
  error: (
    message: string,
    fields?: Record<string, RequestLogField | undefined>,
  ) => void;
};

function assignFields(
  target: Record<string, RequestLogField>,
  fields: Record<string, RequestLogField | undefined>,
) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    target[key] = value;
  }
}

function formatValue(value: RequestLogField): string {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

function formatFields(fields: Record<string, RequestLogField>): string {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => ` ${key}=${formatValue(value)}`).join(
    "",
  );
}

export function shortId(value: string, length = 8): string {
  return value.length <= length ? value : value.slice(0, length);
}

export function formatAgeFromUnix(createdAt: number, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (ageSeconds < 60) return `${ageSeconds}s`;

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m`;

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h`;

  const ageDays = Math.floor(ageHours / 24);
  if (ageDays < 30) return `${ageDays}d`;

  const ageMonths = Math.floor(ageDays / 30);
  if (ageMonths < 12) return `${ageMonths}mo`;

  return `${Math.floor(ageDays / 365)}y`;
}

export function createRequestLogState(): RequestLogState {
  return { fields: {}, errors: [] };
}

export function createRequestLog(state: RequestLogState): RequestLog {
  return {
    setOutcome(outcome, fields = {}) {
      state.outcome = outcome;
      assignFields(state.fields, fields);
    },
    addFields(fields) {
      assignFields(state.fields, fields);
    },
    error(message, fields = {}) {
      const formatted: Record<string, RequestLogField> = {};
      assignFields(formatted, fields);
      state.errors.push({ message, fields: formatted });
    },
  };
}

export function formatRequestLogLine(
  method: string,
  url: URL,
  status: number,
  durationMs: number,
  state: RequestLogState,
): string {
  const location = `${method} ${url.host}${url.pathname}`;
  const outcome = state.outcome ? ` ${state.outcome}` : "";
  return `${location} ${status} ${durationMs.toFixed(1)}ms${outcome}${
    formatFields(state.fields)
  }`;
}

export function formatRequestErrorLine(
  method: string,
  url: URL,
  message: string,
  fields: Record<string, RequestLogField>,
): string {
  return `ERROR ${method} ${url.host}${url.pathname} ${message}${
    formatFields(fields)
  }`;
}
