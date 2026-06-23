// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../lib/env";

declare global {
  var __pg__: ReturnType<typeof postgres> | undefined;
}

// Strip Neon proxy-specific URL params that the postgres npm client doesn't
// understand and passes to the server, which rejects them (e.g. in Docker
// where the connection bypasses the Neon proxy).
function cleanDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("uselibpqcompat");
    return u.toString();
  } catch {
    return url;
  }
}

// postgres() creates a pool config but doesn't connect until the first query,
// so this is safe at build time even in static analysis passes.
const client =
  globalThis.__pg__ ??
  postgres(cleanDatabaseUrl(env.DATABASE_URL), {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Neon pooler doesn't support prepared statements
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__pg__ = client;
}

export const db = drizzle(client, { schema });
export * from "./schema";
