export class AiWikiError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'AiWikiError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export function fail(code, message, hint) {
  const error = { code, message };
  if (hint) error.hint = hint;
  return { ok: false, error };
}

export function ok(data) {
  return Object.assign({ ok: true }, data);
}

export function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
