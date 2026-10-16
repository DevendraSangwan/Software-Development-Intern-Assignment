import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { SlackConnection } from "@prisma/client";
import { config, assertSlackConfiguration } from "./config";
import { prisma } from "./db";

function encryptionKey(): Buffer {
  assertSlackConfiguration();
  return Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex");
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(value: string): string {
  const [ivHex, tagHex, encryptedHex] = value.split(":");
  if (!ivHex || !tagHex || !encryptedHex) throw new Error("Stored Slack token has an invalid format.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

export async function createSlackAuthorizationUrl(tenantId: string): Promise<string> {
  assertSlackConfiguration();
  await prisma.slackOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const state = randomUUID();
  await prisma.slackOAuthState.create({
    data: { state, tenantId, expiresAt: new Date(Date.now() + 10 * 60_000) }
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
  url.searchParams.set("scope", "chat:write,channels:read,groups:read");
  url.searchParams.set("redirect_uri", config.SLACK_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function completeSlackAuthorization(code: string, state: string): Promise<string> {
  assertSlackConfiguration();
  const oauthState = await prisma.slackOAuthState.findUnique({ where: { state } });
  if (!oauthState || oauthState.expiresAt.getTime() < Date.now()) {
    if (oauthState) await prisma.slackOAuthState.delete({ where: { state } });
    throw new Error("Slack authorization state is invalid or expired.");
  }
  await prisma.slackOAuthState.delete({ where: { state } });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.SLACK_CLIENT_ID,
      client_secret: config.SLACK_CLIENT_SECRET,
      redirect_uri: config.SLACK_REDIRECT_URI
    })
  });
  if (!response.ok) throw new Error(`Slack OAuth failed with HTTP ${response.status}.`);
  const result = await response.json() as {
    ok: boolean;
    error?: string;
    access_token?: string;
    team?: { name?: string };
  };
  if (!result.ok || !result.access_token) throw new Error(`Slack OAuth failed: ${result.error ?? "missing access token"}.`);

  await prisma.slackConnection.upsert({
    where: { tenantId: oauthState.tenantId },
    create: {
      tenantId: oauthState.tenantId,
      encryptedToken: encryptToken(result.access_token),
      teamName: result.team?.name ?? null
    },
    update: {
      encryptedToken: encryptToken(result.access_token),
      teamName: result.team?.name ?? null,
      channelId: null,
      channelName: null
    }
  });
  return oauthState.tenantId;
}

export async function getSlackConnection(tenantId: string): Promise<SlackConnection | null> {
  return prisma.slackConnection.findUnique({ where: { tenantId } });
}

export async function listSlackChannels(tenantId: string) {
  const connection = await getSlackConnection(tenantId);
  if (!connection) return null;
  const response = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200", {
    headers: { authorization: `Bearer ${decryptToken(connection.encryptedToken)}` }
  });
  if (!response.ok) throw new Error(`Slack channels request failed with HTTP ${response.status}.`);
  const result = await response.json() as {
    ok: boolean;
    error?: string;
    channels?: Array<{ id: string; name: string; is_member: boolean }>;
  };
  if (!result.ok) throw new Error(`Slack channels request failed: ${result.error ?? "unknown error"}.`);
  return (result.channels ?? []).filter((channel) => channel.is_member).map(({ id, name }) => ({ id, name }));
}

export async function selectSlackChannel(tenantId: string, channelId: string): Promise<void> {
  const connection = await getSlackConnection(tenantId);
  if (!connection) throw new Error("Connect Slack before selecting a notification channel.");
  const channels = await listSlackChannels(tenantId);
  const channel = channels?.find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error("The selected channel is not available to the connected Slack app.");
  await prisma.slackConnection.update({
    where: { tenantId },
    data: { channelId: channel.id, channelName: channel.name }
  });
}

export async function disconnectSlack(tenantId: string): Promise<void> {
  await prisma.slackConnection.deleteMany({ where: { tenantId } });
}

export async function notifyHourlyLimit(tenantId: string, senderEmail: string, maxPerHour: number): Promise<void> {
  const connection = await getSlackConnection(tenantId);
  if (!connection?.channelId) return;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${decryptToken(connection.encryptedToken)}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      channel: connection.channelId,
      text: `Hourly email limit reached for ${senderEmail}. The limit is ${maxPerHour} emails per UTC hour; queued messages will resume in the next window.`
    })
  });
  if (!response.ok) throw new Error(`Slack notification failed with HTTP ${response.status}.`);
  const result = await response.json() as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(`Slack notification failed: ${result.error ?? "unknown error"}.`);
}
