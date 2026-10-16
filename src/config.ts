import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url(),
  TENANT_ID: z.string().min(1).default("demo"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SMTP_HOST: z.string().default("smtp.ethereal.email"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_SECURE: z.string().default("false").transform((value) => value === "true"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  EMAIL_JOB_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/slack/callback"),
  TOKEN_ENCRYPTION_KEY: z.string().default("")
});

export const config = configSchema.parse(process.env);

export function assertSlackConfiguration(): void {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET || !config.TOKEN_ENCRYPTION_KEY) {
    throw new Error("Slack OAuth is not configured. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY.");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(config.TOKEN_ENCRYPTION_KEY)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 bytes).");
  }
}
