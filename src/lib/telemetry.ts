// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Malloyyo's own product telemetry. This is intentionally server-only: browser
// navigations report to a same-origin route, and only this module talks to PostHog.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { PostHog, type EventMessage } from "posthog-node";
import { logger } from "./logger";
import { VERSION } from "./version";

export const POSTHOG_HOST = "https://us.i.posthog.com";

// Public project configuration, intentionally compiled into every distribution.
// Keep this analytics project free of sensitive feature-flag or remote-config payloads.
const POSTHOG_PROJECT_TOKEN = "phc_BAR8UTgMWRi3gbpqgcQDYyngn5joRKGifU9GWJV9KA6R";

export type QueryEntrypoint = "mcp" | "ltool" | "dashboard" | "ask" | "chat";
export type TelemetryOutcome = "success" | "error";
export type ModelPublishMethod = "github_create" | "github_refresh" | "github_webhook" | "cli_push";
export type McpToolName = "list_sources" | "describe_source" | "open_share_link" | "yo_help" | "other";

export type TelemetryEvent =
  | {
    event: "query ran";
    properties: {
      entrypoint: QueryEntrypoint;
      outcome: TelemetryOutcome;
      duration_ms: number;
      author_kind: "human" | "assistant";
      client_family: "browser" | "claude" | "chatgpt" | "cursor" | "other";
    };
  }
  | { event: "page viewed"; properties: { page: string; authenticated: boolean } }
  | { event: "user signed in"; properties: { auth_mode: "hosted" | "self_hosted"; first_login: boolean } }
  | {
    event: "model published";
    properties: {
      method: ModelPublishMethod;
      outcome: TelemetryOutcome;
      created_dataset: boolean;
      source_count: number;
      file_count: number;
      dashboard_count: number;
    };
  }
  | { event: "dataset removed"; properties: Record<string, never> }
  | { event: "query saved"; properties: { entrypoint: "ltool" } }
  | { event: "query favorite changed"; properties: { favorited: boolean } }
  | { event: "mcp tool called"; properties: { tool: McpToolName; outcome: TelemetryOutcome } };

export interface TelemetryCaptureClient {
  capture(message: EventMessage): void;
}

export interface TelemetryDependencies {
  client?: TelemetryCaptureClient | null;
  configuration?: TelemetryConfiguration;
  loadTelemetryId?: () => Promise<string>;
  writeDebug?: (payload: Record<string, unknown>) => void;
}

export interface TelemetryConfiguration {
  hosted: boolean;
  enabled: boolean;
  debug: boolean;
  tenantId: string;
  accountId: string;
}

let posthog: PostHog | null | undefined;
let cachedTelemetryId: Promise<string> | undefined;

function productionClient(): TelemetryCaptureClient | null {
  if (posthog !== undefined) return posthog;
  posthog = new PostHog(POSTHOG_PROJECT_TOKEN, {
    host: POSTHOG_HOST,
    disableGeoip: true,
  });
  posthog.on("error", (error) => {
    logger.warn("telemetry delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return posthog;
}

export function telemetryConfiguration(source: NodeJS.ProcessEnv = process.env): TelemetryConfiguration {
  const tenantId = source.MALLOYYO_TENANT_ID?.trim() ?? "";
  const hosted = tenantId !== "";
  return {
    hosted,
    enabled: hosted || source.MALLOYYO_TELEMETRY_DISABLED !== "1",
    debug: !hosted && source.MALLOYYO_TELEMETRY_DEBUG === "1",
    tenantId,
    accountId: source.MALLOYYO_ACCOUNT_ID?.trim() ?? "",
  };
}

export function telemetryPageTrackingEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return telemetryConfiguration(source).enabled;
}

async function loadTelemetryId(): Promise<string> {
  cachedTelemetryId ??= (async () => {
    const [{ db, instanceSettings }, { env }] = await Promise.all([import("@/db"), import("./env")]);
    const [inserted] = await db
      .insert(instanceSettings)
      .values({ instanceCode: env.INSTANCE_CODE })
      .onConflictDoNothing()
      .returning({ telemetryId: instanceSettings.telemetryId });
    if (inserted) return inserted.telemetryId;
    const [existing] = await db
      .select({ telemetryId: instanceSettings.telemetryId })
      .from(instanceSettings)
      .where(eq(instanceSettings.instanceCode, env.INSTANCE_CODE))
      .limit(1);
    if (!existing) throw new Error("instance settings disappeared while loading telemetry identity");
    return existing.telemetryId;
  })();
  return cachedTelemetryId;
}

export function pseudonymousActorId(telemetryId: string, userId: string): string {
  return createHash("sha256").update(`${telemetryId}:${userId}`, "utf8").digest("hex");
}

export function authorKind(authorModel: string | null | undefined): "human" | "assistant" {
  return authorModel === "human" ? "human" : "assistant";
}

export function clientFamily(userAgent: string | null | undefined): "browser" | "claude" | "chatgpt" | "cursor" | "other" {
  const value = userAgent?.toLowerCase() ?? "";
  if (value.includes("claude")) return "claude";
  if (/chatgpt|openai/.test(value)) return "chatgpt";
  if (value.includes("cursor")) return "cursor";
  if (/mozilla|safari|chrome|firefox|webkit/.test(value)) return "browser";
  return "other";
}

export function mcpToolName(name: string): McpToolName {
  return name === "list_sources" ||
    name === "describe_source" ||
    name === "open_share_link" ||
    name === "yo_help"
    ? name
    : "other";
}

export function historyTelemetryEvent(input: {
  entrypoint?: QueryEntrypoint;
  toolName: string;
  executed?: boolean | null;
  error?: string | null;
  durationMs?: number | null;
  authorModel?: string | null;
  userAgent?: string | null;
}): TelemetryEvent | null {
  if (input.toolName === "query") {
    if (input.executed !== true || input.entrypoint === undefined) return null;
    return {
      event: "query ran",
      properties: {
        entrypoint: input.entrypoint,
        outcome: input.error ? "error" : "success",
        duration_ms: Math.max(0, input.durationMs ?? 0),
        author_kind: authorKind(input.authorModel),
        client_family: clientFamily(input.userAgent),
      },
    };
  }
  if (input.entrypoint !== "mcp") return null;
  return {
    event: "mcp tool called",
    properties: {
      tool: mcpToolName(input.toolName),
      outcome: input.error ? "error" : "success",
    },
  };
}

export async function captureTelemetry(
  event: TelemetryEvent,
  userId?: string | null,
  dependencies: TelemetryDependencies = {},
): Promise<void> {
  try {
    const configuration = dependencies.configuration ?? telemetryConfiguration();
    if (!configuration.enabled) return;

    const telemetryId =
      configuration.hosted && !userId
        ? null
        : await (dependencies.loadTelemetryId ?? loadTelemetryId)();
    const instanceId = configuration.hosted ? configuration.tenantId : telemetryId;
    if (!instanceId) throw new Error("self-hosted telemetry identity is missing");
    let distinctId = instanceId;
    if (userId) {
      if (!telemetryId) throw new Error("actor identity salt is missing");
      distinctId = pseudonymousActorId(telemetryId, userId);
    }
    const properties: Record<string, unknown> = {
      ...event.properties,
      app_version: VERSION,
      deployment: configuration.hosted ? "hosted" : "self_hosted",
      instance_id: instanceId,
      $process_person_profile: false,
      ...(configuration.accountId ? { account_id: configuration.accountId } : {}),
    };
    const message: EventMessage = { distinctId, event: event.event, properties, disableGeoip: true };

    if (configuration.debug) {
      (dependencies.writeDebug ?? ((payload) => console.log(JSON.stringify({ event: "telemetry.debug", payload }))))({
        distinct_id: distinctId,
        event: event.event,
        properties,
      });
      return;
    }

    (dependencies.client === undefined ? productionClient() : dependencies.client)?.capture(message);
  } catch (error) {
    // Telemetry is never allowed to change the product operation it observes.
    logger.warn("telemetry capture failed", {
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Flush the official SDK before an explicit one-shot process exits (the smoke only). */
export async function shutdownTelemetry(): Promise<void> {
  if (posthog) await posthog.shutdown();
  posthog = undefined;
}

const EXACT_PAGES = new Set([
  "/",
  "/admin",
  "/admin/users",
  "/authenticate",
  "/datasets/new",
  "/datasets/new/github",
  "/login",
  "/login/recover",
  "/logout",
  "/ltool",
  "/oauth/consent",
  "/reauth",
]);

export function normalizePagePath(pathname: string): string {
  const path = pathname.split("?", 1)[0]?.replace(/\/$/, "") || "/";
  if (EXACT_PAGES.has(path)) return path;
  if (/^\/admin\/x\/[^/]+$/.test(path)) return "/admin/x/:slug";
  if (/^\/datasets\/[^/]+\/dashboard\/[^/]+$/.test(path)) return "/datasets/:id/dashboard/:name";
  if (/^\/datasets\/[^/]+\/questions$/.test(path)) return "/datasets/:id/questions";
  if (/^\/datasets\/[^/]+\/config$/.test(path)) return "/datasets/:id/config";
  if (/^\/datasets\/[^/]+$/.test(path)) return "/datasets/:id";
  if (/^\/ltool\/[^/]+$/.test(path)) return "/ltool/:slug";
  return "/other";
}
