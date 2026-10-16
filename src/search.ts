import { Client } from "@elastic/elasticsearch";
import { Email, EmailStatus } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./db";

const INDEX = "scheduled-emails";
export const elasticsearch = new Client({ node: config.ELASTICSEARCH_URL });

export async function ensureEmailIndex(): Promise<void> {
  const exists = await elasticsearch.indices.exists({ index: INDEX });
  if (!exists) {
    try {
      await elasticsearch.indices.create({
        index: INDEX,
        mappings: {
          properties: {
            id: { type: "keyword" },
            tenantId: { type: "keyword" },
            senderId: { type: "keyword" },
            senderEmail: { type: "keyword" },
            senderName: { type: "text" },
            sender: {
              properties: {
                name: { type: "text" },
                email: { type: "keyword" }
              }
            },
            recipient: { type: "keyword" },
            subject: { type: "text" },
            textBody: { type: "text" },
            status: { type: "keyword" },
            scheduledAt: { type: "date" },
            sentAt: { type: "date" },
            createdAt: { type: "date" }
          }
        }
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "meta" in error &&
        typeof error.meta === "object" &&
        error.meta !== null &&
        "statusCode" in error.meta &&
        error.meta.statusCode === 400 &&
        "body" in error.meta &&
        typeof error.meta.body === "object" &&
        error.meta.body !== null &&
        "error" in error.meta.body &&
        typeof error.meta.body.error === "object" &&
        error.meta.body.error !== null &&
        "type" in error.meta.body.error &&
        error.meta.body.error.type === "resource_already_exists_exception"
      ) {
        return;
      }
      throw error;
    }
  }
}

export async function indexEmail(email: Email & { sender: { name: string; email: string } }): Promise<void> {
  await elasticsearch.index({
    index: INDEX,
    id: email.id,
    document: {
      id: email.id,
      tenantId: email.tenantId,
      senderId: email.senderId,
      senderEmail: email.sender.email,
      senderName: email.sender.name,
      sender: email.sender,
      recipient: email.recipient,
      subject: email.subject,
      textBody: email.textBody,
      status: email.status,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
      createdAt: email.createdAt
    }
  });
}

export async function rebuildEmailIndex(tenantId: string): Promise<number> {
  await ensureEmailIndex();
  const emails = await prisma.email.findMany({
    where: { tenantId },
    include: { sender: { select: { name: true, email: true } } }
  });
  for (const email of emails) await indexEmail(email);
  return emails.length;
}

export async function searchEmails(tenantId: string, query: string, statuses?: EmailStatus[]) {
  const response = await elasticsearch.search({
    index: INDEX,
    query: {
      bool: {
        filter: [
          { term: { tenantId } },
          ...(statuses ? [{ terms: { status: statuses } }] : [])
        ],
        must: query.trim()
          ? [{ multi_match: { query, fields: ["recipient", "senderEmail", "subject", "textBody"] } }]
          : [{ match_all: {} }]
      }
    },
    sort: [{ createdAt: "desc" }],
    size: 100
  });
  return response.hits.hits.map((hit) => hit._source);
}
