// Errors with a code the popup understands (the same names the helper uses in its `error` replies).
//
// `transient` marks failures worth retrying (a dropped connection, a 503). Everything else stops
// the job right away.

export class Coded extends Error {
  constructor(code, message, { status, detail, transient = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.transient = transient;
  }
}

export const coded = (code, message, extra) => new Coded(code, message, extra);

/** A failure worth another attempt (network trouble, 5xx, a connection that ended early). */
export const transient = (message, extra = {}) => new Coded("network", message, { ...extra, transient: true });

/** Anything that went wrong in the archive itself: corrupt, hostile, or changed on the server. */
export const failed = (message, extra) => new Coded("failed", message, extra);

export function isTransient(e) {
  return Boolean(e && e.transient);
}

/** The wire form of an error: `{code, message, detail, http_status?}`. */
export function describe(e) {
  if (e instanceof Coded) {
    return { code: e.code, message: e.message, detail: e.detail || e.message, http_status: e.status };
  }
  if (e?.name === "AbortError") return { code: "cancelled", message: "Stopped.", detail: "aborted" };
  const text = e?.message || String(e);
  return { code: "internal", message: text, detail: e?.stack || text };
}
