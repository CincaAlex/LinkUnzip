// Which program extracts a job: the browser engine, or the Windows helper when it is turned on in
// Settings and can do this one. The background decides with it and the popup shows the same
// answer before Start. The file list, the Cost Analysis and the preview always come from the
// browser engine.

/** Helper features this version needs: the file list's ticks and the zip's own top folder. */
export const HELPER_NEEDS = ["marks", "drop_top"];

/** Is this helper (its `hello`) new enough to extract for this version? */
export const helperCanExtract = (helper) => Boolean(helper) && HELPER_NEEDS.every((f) => helper.features?.includes(f));

/**
 * `{via, why, vars}`: "helper" or "engine". With the helper turned on, `why` says what made the
 * browser take this one: an English sentence for t() in i18n.js, with `vars` for its {placeholders}.
 */
export function engineFor(job, settings, helper) {
  if (!settings?.useHelper) return { via: "engine", why: null };
  if (!helper) return { via: "engine", why: "the helper isn't installed or didn't start" };
  if (!helperCanExtract(helper)) return { via: "engine", why: "the helper on this PC ({version}) is too old for this", vars: { version: helper.version } };
  if (job?.inner?.length) return { via: "engine", why: "the helper can't open a zip inside a zip" };
  if (job?.report?.encrypted > 0) return { via: "engine", why: "the helper can't open password-protected files" };
  if (job?.loginSent) return { via: "engine", why: "this link needs your login, and only the browser sends it" };
  return { via: "helper", why: null };
}
