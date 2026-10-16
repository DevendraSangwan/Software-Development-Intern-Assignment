import { Queue } from "bullmq";
import { redis } from "./redis";
import { config } from "./config";

export const EMAIL_QUEUE_NAME = "scheduled-emails";

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: config.EMAIL_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  }
});

export interface EmailJobData {
  emailId: string;
}
