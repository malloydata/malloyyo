function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  // Optional — when unset, Malloy runs against plain (in-memory) DuckDB
  // instead of MotherDuck; models supply their own sources/attachments.
  get MOTHERDUCK_TOKEN() {
    return process.env.MOTHERDUCK_TOKEN ?? "";
  },
  get MOTHERDUCK_DATABASE() {
    return process.env.MOTHERDUCK_DATABASE ?? "mayolo";
  },
  get APP_BASE_URL() {
    return process.env.APP_BASE_URL ?? "http://localhost:3000";
  },
  // Human-readable name for this deployment, shown in the UI, the MCP
  // serverInfo, and prefixed onto every tool description so Claude can tell
  // multiple connected Malloyyo instances apart.
  get INSTANCE_NAME() {
    return process.env.INSTANCE_NAME ?? "Malloyyo";
  },
  // Short slug prefix for this deployment (e.g. main / stg / gld). Prefixed
  // onto shareable query slugs so a slug from one instance fails loudly when
  // handed to another.
  get INSTANCE_CODE() {
    return (process.env.INSTANCE_CODE ?? "main").toLowerCase();
  },
  // Comma-separated list of Google emails that are automatically admins.
  get APP_ADMIN_EMAILS(): string[] {
    return (process.env.APP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  // Optional — needed only for private GitHub repos.
  get GITHUB_TOKEN() {
    return process.env.GITHUB_TOKEN ?? "";
  },
};
