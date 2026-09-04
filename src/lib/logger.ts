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
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
  base: undefined, // no pid/hostname noise in every line
});
