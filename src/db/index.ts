import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../lib/env";

declare global {
  // eslint-disable-next-line no-var
  var __pg__: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __db__: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

function initDb() {
  const client =
    globalThis.__pg__ ??
    postgres(env.DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      prepare: false, // Neon pooler doesn't support prepared statements
    });
  if (process.env.NODE_ENV !== "production") globalThis.__pg__ = client;
  return drizzle(client, { schema });
}

// Lazy proxy: defers DATABASE_URL read until the first actual query,
// so importing this module during Next.js build-time static analysis
// doesn't require a live database connection.
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    if (!globalThis.__db__) globalThis.__db__ = initDb();
    return Reflect.get(globalThis.__db__, prop);
  },
});

export * from "./schema";
