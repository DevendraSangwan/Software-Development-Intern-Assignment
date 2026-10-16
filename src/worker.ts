import { DelayedError, Job, Worker } from "bullmq";
import { config } from "./config";
import { prisma } from "./db";
import { mailTransport, sendEmail } from "./mail";
import { emailQueue, EMAIL_QUEUE_NAME, EmailJobData } from "./queue";
import { redis } from "./redis";
import { elasticsearch, ensureEmailIndex, indexEmail } from "./search";
import { reserveSendSlot } from "./rate-limit";
import { getSlackConnection, notifyHourlyLimit } from "./slack";

async function reconcileScheduledEmails(): Promise<void> {
  const interrupted = await prisma.email.findMany({
    where: { tenantId: config.TENANT_ID, status: "SENDING" },
    select: { id: true }
  });
  for (const email of interrupted) {
    const job = await emailQueue.getJob(email.id);
    if (!job) {
      await prisma.email.updateMany({
        where: { id: email.id, status: "SENDING" },
        data: { status: "SCHEDULED" }
      });
      continue;
    }
    const state = await job.getState();
    if (state === "failed") await job.retry("failed");
    if (state === "completed") {
      await prisma.email.updateMany({
        where: { id: email.id, status: "SENDING" },
        data: { status: "FAILED", lastError: "Queue job completed while the email record remained in sending state; inspect delivery before retrying." }
      });
    }
  }
  const pending = await prisma.email.findMany({
    where: { tenantId: config.TENANT_ID, status: "SCHEDULED" },
    select: { id: true, scheduledAt: true }
  });
  for (const email of pending) {
    await emailQueue.add("send-email", { emailId: email.id }, {
      jobId: email.id,
      delay: Math.max(0, email.scheduledAt.getTime() - Date.now())
    });
  }
  console.log(`Reconciled ${pending.length} scheduled email(s).`);
}

async function processEmail(job: Job<EmailJobData>, token?: string): Promise<void> {
  const email = await prisma.email.findFirst({
    where: { id: job.data.emailId, tenantId: config.TENANT_ID },
    include: { sender: true }
  });
  if (!email || email.status === "FAILED") return;
  if (email.status === "SENT") {
    await indexEmail(email);
    return;
  }
  if (!email.sender.enabled) {
    await prisma.email.update({ where: { id: email.id }, data: { status: "FAILED", lastError: "Sender is disabled." } });
    await indexEmail({ ...email, status: "FAILED" });
    return;
  }

  const slot = await reserveSendSlot(email.senderId);
  if (!slot.allowed) {
    if (slot.hourlyLimitReached) {
      const connection = await getSlackConnection(email.tenantId);
      if (connection?.channelId) {
        const window = new Date().toISOString().slice(0, 13);
        const alertKey = `email-limit-alert:${email.senderId}:${window}`;
        const shouldNotify = await redis.set(alertKey, "1", "EX", 7200, "NX");
        if (shouldNotify === "OK") {
          try {
            await notifyHourlyLimit(
              email.tenantId,
              email.sender.email,
              config.MAX_EMAILS_PER_HOUR_PER_SENDER
            );
          } catch (error) {
            await redis.del(alertKey);
            console.error(`Could not send Slack rate-limit notification for sender ${email.senderId}:`, error);
          }
        }
      }
    }
    if (!token) throw new Error("BullMQ did not provide a lock token for delayed scheduling.");
    await job.moveToDelayed(slot.retryAt, token);
    throw new DelayedError();
  }

  const sending = await prisma.email.update({
    where: { id: email.id },
    data: { status: "SENDING", attempts: { increment: 1 }, lastError: null },
    include: { sender: { select: { name: true, email: true } } }
  });
  await indexEmail(sending);
  try {
    await sendEmail({
      senderName: email.sender.name,
      senderEmail: email.sender.email,
      recipient: email.recipient,
      subject: email.subject,
      textBody: email.textBody,
      emailId: email.id
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMTP delivery failed.";
    const exhausted = job.attemptsMade + 1 >= config.EMAIL_JOB_ATTEMPTS;
    const retrying = await prisma.email.update({
      where: { id: email.id },
      data: { status: exhausted ? "FAILED" : "SCHEDULED", lastError: message },
      include: { sender: { select: { name: true, email: true } } }
    });
    await indexEmail(retrying);
    throw error;
  }
  const sent = await prisma.email.update({
    where: { id: email.id },
    data: { status: "SENT", sentAt: new Date(), lastError: null },
    include: { sender: { select: { name: true, email: true } } }
  });
  await indexEmail(sent);
}

async function start(): Promise<void> {
  await ensureEmailIndex();
  await mailTransport.verify();
  await reconcileScheduledEmails();
  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmail, {
    connection: redis,
    concurrency: config.WORKER_CONCURRENCY
  });
  worker.on("completed", (job) => console.log(`Email job ${job.id} completed.`));
  worker.on("failed", (job, error) => {
    if (!job) return;
    void (async () => {
      console.error(`Email job ${job.id} failed: ${error.message}`);
      const emailId = job.data.emailId;
      const email = await prisma.email.findFirst({ where: { id: emailId }, include: { sender: { select: { name: true, email: true } } } });
      if (!email || email.status === "SENT") return;
      if (job.attemptsMade >= config.EMAIL_JOB_ATTEMPTS) {
        const failed = await prisma.email.update({
          where: { id: emailId },
          data: { status: "FAILED", lastError: error.message }
        });
        await indexEmail({ ...failed, sender: email.sender });
      }
    })().catch((error: unknown) => console.error(`Could not persist final failure for job ${job.id}:`, error));
  });
  worker.on("error", (error) => console.error("BullMQ worker error:", error));
  console.log(`Email worker running with concurrency ${config.WORKER_CONCURRENCY}.`);

  const shutdown = async () => {
    await worker.close();
    await emailQueue.close();
    await mailTransport.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

start().catch((error: unknown) => {
  console.error("Email worker could not start:", error);
  void Promise.all([
    emailQueue.close(),
    mailTransport.close(),
    elasticsearch.close(),
    prisma.$disconnect(),
    redis.quit()
  ]).then(() => {
    process.exitCode = 1;
  }).catch((cleanupError: unknown) => {
    console.error("Worker startup cleanup failed:", cleanupError);
    process.exitCode = 1;
  });
});
