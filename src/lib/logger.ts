import pino from "pino";

/**
 * The one server-side logger. Structured JSON (greppable in `docker logs`),
 * level from LOG_LEVEL (default "info"), and token fields redacted — this
 * app stores Google credentials and must never print them.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "tokens",
      "tokensEnc",
      "refresh_token",
      "access_token",
      "id_token",
      // wildcards are SINGLE-SEGMENT in fast-redact (*.access_token matches
      // depth-2 only) — they are best-effort for shallow nests. The real
      // defense is discipline: log err.message, never raw error objects,
      // anywhere OAuth/HTTP clients can attach credential payloads.
      "*.refresh_token",
      "*.access_token",
      "*.id_token",
      "*.tokens",
      "*.tokensEnc",
      "*.authorization",
      "*.cookie",
      "req.headers.authorization",
      "req.headers.cookie",
      "err.response.data",
      "err.config.headers",
    ],
    censor: "[redacted]",
  },
  base: undefined, // no pid/hostname noise in every line
});
