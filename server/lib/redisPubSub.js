import { EventEmitter } from "node:events";
import { extractTrace, injectTrace } from "./traceContext.js";

const CHANNEL = "helphone:contract-events:v1";
const localBus = new EventEmitter();
let publisher;
let subscriber;
let connecting;

export async function connectEventBus({ redisUrl = process.env.REDIS_URL } = {}) {
  if (!redisUrl) return false;
  if (connecting) return connecting;
  connecting = (async () => {
    const Redis = (await import("ioredis")).default;
    publisher = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    publisher.on("error", (error) => console.error("[events:redis-publisher]", error.message));
    subscriber.on("error", (error) => console.error("[events:redis-subscriber]", error.message));
    subscriber.on("message", (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const event = JSON.parse(message);
        if (isContractEvent(event)) localBus.emit("event", withReceivedTrace(event));
      } catch (error) {
        console.error("[events:redis] discarded malformed event", error.message);
      }
    });
    await subscriber.subscribe(CHANNEL);
    return true;
  })().catch((error) => {
    publisher?.disconnect();
    subscriber?.disconnect();
    publisher = undefined;
    subscriber = undefined;
    connecting = undefined;
    throw error;
  });
  return connecting;
}

function isContractEvent(value) {
  return value && typeof value === "object" &&
    typeof value.topic === "string" && value.topic.length <= 64 &&
    Number.isSafeInteger(value.ledger) && typeof value.id === "string" && value.id.length <= 256 &&
    (value.tenantId === undefined || (typeof value.tenantId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.tenantId)));
}

/**
 * Subscriber side of the #791 contract: keep the publisher's traceId and expose
 * its span as a link (fan-out → links, never a forced parent). Messages from
 * pre-#791 publishers have no `trace` and pass through unchanged.
 */
function withReceivedTrace(event) {
  const ctx = extractTrace(event);
  if (!ctx) return event;
  return { ...event, trace: { ...event.trace, traceId: ctx.traceId, links: [{ traceId: ctx.traceId, spanId: ctx.spanId }] } };
}

export async function publishContractEvent(event, { traceparent, tracestate } = {}) {
  if (!isContractEvent(event)) throw new TypeError("Invalid contract event");
  const parent = traceparent || event.trace?.traceparent;
  if (parent) event = injectTrace(event, parent, tracestate || event.trace?.tracestate);
  if (publisher) {
    const firstPublisher = await publisher.set(`helphone:event:seen:${event.id}`, "1", "EX", 60, "NX");
    if (firstPublisher !== "OK") return false;
    await publisher.publish(CHANNEL, JSON.stringify(event));
  }
  else localBus.emit("event", withReceivedTrace(event));
  return true;
}

export function subscribeContractEvents(handler) {
  localBus.on("event", handler);
  return () => localBus.off("event", handler);
}

export async function closeEventBus() {
  await Promise.all([publisher?.quit(), subscriber?.quit()].filter(Boolean));
  publisher = undefined;
  subscriber = undefined;
  connecting = undefined;
}
