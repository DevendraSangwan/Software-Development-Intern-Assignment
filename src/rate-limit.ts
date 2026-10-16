import { redis } from "./redis";
import { config } from "./config";

const RESERVE_SEND_SLOT = `
local now = tonumber(ARGV[1])
local hourlyLimit = tonumber(ARGV[2])
local minInterval = tonumber(ARGV[3])
local hourKey = KEYS[1]
local spacingKey = KEYS[2]
local count = tonumber(redis.call("GET", hourKey) or "0")
local hourEnd = tonumber(ARGV[4])
local nextSend = tonumber(redis.call("GET", spacingKey) or "0")

if count >= hourlyLimit then
  return hourEnd
end
if nextSend > now then
  return nextSend
end

redis.call("INCR", hourKey)
redis.call("EXPIRE", hourKey, 7200)
redis.call("SET", spacingKey, now + minInterval, "PX", minInterval + 60000)
return 0
`;

export type SlotReservation =
  | { allowed: true }
  | { allowed: false; retryAt: number; hourlyLimitReached: boolean };

export async function reserveSendSlot(senderId: string): Promise<SlotReservation> {
  const now = Date.now();
  const hourWindow = new Date(now).toISOString().slice(0, 13);
  const hourEnd = new Date(
    Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
      new Date(now).getUTCHours() + 1
    )
  ).getTime();
  const hourKey = `email-limit:${senderId}:${hourWindow}`;
  const spacingKey = "email-spacing:global";
  const result = Number(await redis.eval(
    RESERVE_SEND_SLOT,
    2,
    hourKey,
    spacingKey,
    now,
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    config.MIN_SEND_INTERVAL_MS,
    hourEnd
  ));

  if (result === 0) return { allowed: true };
  return {
    allowed: false,
    retryAt: result,
    hourlyLimitReached: result === hourEnd
  };
}
