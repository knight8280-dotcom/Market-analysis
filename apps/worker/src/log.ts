import { redactSecrets } from "@market/config";
import { pino, type Logger } from "pino";

/**
 * Structured JSON logs (spec §10). Secret env values are scrubbed from every message and error,
 * and common credential fields are redacted by path.
 */
export function createLogger(level: string, bindings: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: "worker", ...bindings },
    redact: {
      paths: [
        "*.apiKey",
        "*.password",
        "*.token",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((a) => (typeof a === "string" ? redactSecrets(a) : a)) as Parameters<
            typeof method
          >,
        );
      },
    },
    formatters: {
      log(object) {
        const err = object.err;
        if (err instanceof Error) {
          return { ...object, err: { name: err.name, message: redactSecrets(err.message) } };
        }
        return object;
      },
    },
  });
}

export type { Logger };
