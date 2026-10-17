import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { scrubText } from "./lib/redact.js";

let sdk;

export function initializeTelemetry() {
  if (sdk) return;
  const configuredEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = configuredEndpoint
    ? configuredEndpoint.endsWith("/v1/traces")
      ? configuredEndpoint
      : `${configuredEndpoint.replace(/\/$/, "")}/v1/traces`
    : undefined;
  sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    ...(endpoint ? { traceExporter: new OTLPTraceExporter({ url: endpoint }) } : {}),
  });
  sdk.start();
}

export function traceIdFromRequest(req) {
  const traceparent = req.get?.("traceparent") || req.headers?.traceparent;
  const match = typeof traceparent === "string" &&
    traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return match && !/^0+$/.test(match[1]) ? match[1].toLowerCase() : null;
}

export function telemetryErrorHandler(req, res) {
  const traceId = traceIdFromRequest(req);
  const { message, componentStack, clientTs } = req.body || {};
  const receivedAt = Date.now();
  console.error(JSON.stringify({
    event: "client_error",
    traceId,
    message: typeof message === "string" ? scrubText(message.slice(0, 500)) : "Unknown client error",
    componentStack: typeof componentStack === "string" ? scrubText(componentStack.slice(0, 2000)) : undefined,
    // Event time (client clock) vs ingest time (server clock), kept apart for the incident tape (#794).
    clientTs: Number.isFinite(clientTs) ? clientTs : undefined,
    ingestDelayMs: Number.isFinite(clientTs) ? receivedAt - clientTs : undefined,
    timestamp: new Date(receivedAt).toISOString(),
  }));
  res.status(202).json({ accepted: true, traceId });
}

export async function shutdownTelemetry() {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
