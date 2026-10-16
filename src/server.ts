import express, { NextFunction, Request, Response } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { z } from "zod";
import { EmailStatus } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./db";
import { emailQueue } from "./queue";
import { elasticsearch, indexEmail, rebuildEmailIndex, searchEmails } from "./search";
import { redis } from "./redis";
import {
  completeSlackAuthorization,
  createSlackAuthorizationUrl,
  disconnectSlack,
  getSlackConnection,
  listSlackChannels,
  selectSlackChannel
} from "./slack";

const app = express();
const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: bullBoardAdapter
});
app.use("/admin/queues", bullBoardAdapter.getRouter());
app.use(express.json({ limit: "1mb" }));

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<unknown>
): express.RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

app.use((_request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", config.APP_BASE_URL);
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

const createSenderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320)
});

const scheduleEmailSchema = z.object({
  senderId: z.string().uuid(),
  recipient: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(998),
  textBody: z.string().min(1).max(100_000),
  scheduledAt: z.string().datetime({ offset: true })
});

const channelSchema = z.object({ channelId: z.string().min(1) });
const emailListStatusSchema = z.enum(["all", "scheduled", "sent", "failed"]);

app.get("/api/health", asyncRoute(async (_request, response) => {
  await prisma.$queryRaw`SELECT 1`;
  await emailQueue.waitUntilReady();
  response.json({ ok: true });
}));

app.get("/api/senders", asyncRoute(async (_request, response) => {
  const senders = await prisma.sender.findMany({
    where: { tenantId: config.TENANT_ID },
    orderBy: { createdAt: "asc" }
  });
  response.json(senders);
}));

app.post("/api/senders", asyncRoute(async (request, response) => {
  const input = createSenderSchema.parse(request.body);
  const sender = await prisma.sender.create({
    data: { tenantId: config.TENANT_ID, ...input }
  });
  response.status(201).json(sender);
}));

app.get("/api/emails", asyncRoute(async (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q : "";
  const status = typeof request.query.status === "string" ? request.query.status : "all";
  const parsedStatus = emailListStatusSchema.safeParse(status);
  if (!parsedStatus.success) {
    response.status(400).json({ error: "Status must be one of: all, scheduled, sent, failed." });
    return;
  }
  const statusFilters: Record<z.infer<typeof emailListStatusSchema>, EmailStatus[] | undefined> = {
    all: undefined,
    scheduled: [EmailStatus.SCHEDULED, EmailStatus.SENDING],
    sent: [EmailStatus.SENT],
    failed: [EmailStatus.FAILED]
  };
  const statuses = statusFilters[parsedStatus.data];
  if (query.trim()) {
    response.json(await searchEmails(config.TENANT_ID, query, statuses));
    return;
  }
  const emails = await prisma.email.findMany({
    where: { tenantId: config.TENANT_ID, ...(statuses ? { status: { in: statuses } } : {}) },
    include: { sender: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  response.json(emails);
}));

app.post("/api/emails", asyncRoute(async (request, response) => {
  const input = scheduleEmailSchema.parse(request.body);
  const sender = await prisma.sender.findFirst({
    where: { id: input.senderId, tenantId: config.TENANT_ID, enabled: true }
  });
  if (!sender) {
    response.status(404).json({ error: "Enabled sender not found." });
    return;
  }

  const scheduledAt = new Date(input.scheduledAt);
  const email = await prisma.email.create({
    data: {
      tenantId: config.TENANT_ID,
      senderId: sender.id,
      recipient: input.recipient,
      subject: input.subject,
      textBody: input.textBody,
      scheduledAt
    },
    include: { sender: { select: { name: true, email: true } } }
  });

  try {
    await emailQueue.add("send-email", { emailId: email.id }, {
      jobId: email.id,
      delay: Math.max(0, scheduledAt.getTime() - Date.now())
    });
    await indexEmail(email);
  } catch (error) {
    console.error(`Email ${email.id} was saved but queue/index setup failed; startup reconciliation will retry.`, error);
    response.status(503).json({
      error: "The email was saved, but queue setup or search indexing did not complete. The scheduler will retry queue setup on startup.",
      emailId: email.id
    });
    return;
  }
  response.status(201).json(email);
}));

app.get("/api/slack/status", asyncRoute(async (_request, response) => {
  const connection = await getSlackConnection(config.TENANT_ID);
  response.json({
    connected: Boolean(connection),
    teamName: connection?.teamName ?? null,
    channelId: connection?.channelId ?? null,
    channelName: connection?.channelName ?? null
  });
}));

app.get("/api/slack/connect", asyncRoute(async (_request, response) => {
  response.redirect(await createSlackAuthorizationUrl(config.TENANT_ID));
}));

app.get("/api/slack/callback", asyncRoute(async (request, response) => {
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const error = typeof request.query.error === "string" ? request.query.error : "";
  if (error) {
    response.redirect(`${config.APP_BASE_URL}/?slack=error`);
    return;
  }
  if (!code || !state) {
    response.status(400).send("Slack did not return an authorization code and state.");
    return;
  }
  await completeSlackAuthorization(code, state);
  response.redirect(`${config.APP_BASE_URL}/?slack=connected`);
}));

app.get("/api/slack/channels", asyncRoute(async (_request, response) => {
  const channels = await listSlackChannels(config.TENANT_ID);
  if (!channels) {
    response.status(409).json({ error: "Connect Slack before loading channels." });
    return;
  }
  response.json(channels);
}));

app.post("/api/slack/channel", asyncRoute(async (request, response) => {
  const { channelId } = channelSchema.parse(request.body);
  await selectSlackChannel(config.TENANT_ID, channelId);
  response.json({ ok: true });
}));

app.delete("/api/slack", asyncRoute(async (_request, response) => {
  await disconnectSlack(config.TENANT_ID);
  response.sendStatus(204);
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "Invalid request.", details: error.issues });
    return;
  }
  console.error("API request failed:", error);
  response.status(500).json({
    error: error instanceof Error ? error.message : "An unexpected server error occurred."
  });
});

let server: ReturnType<typeof app.listen>;
async function start(): Promise<void> {
  const indexed = await rebuildEmailIndex(config.TENANT_ID);
  console.log(`Indexed ${indexed} existing email(s) in Elasticsearch.`);
  server = app.listen(config.API_PORT, () => {
    console.log(`API listening on http://localhost:${config.API_PORT}`);
    console.log(`BullMQ dashboard available at http://localhost:${config.API_PORT}/admin/queues`);
  });
}

async function shutdown(): Promise<void> {
  const httpClose = server
    ? new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })
    : Promise.resolve();
  await Promise.all([
    httpClose,
    emailQueue.close(),
    prisma.$disconnect(),
    elasticsearch.close(),
    redis.quit()
  ]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
start().catch(async (error: unknown) => {
  console.error("API could not start:", error);
  await Promise.all([
    emailQueue.close(),
    prisma.$disconnect(),
    elasticsearch.close(),
    redis.quit()
  ]);
  process.exitCode = 1;
});
