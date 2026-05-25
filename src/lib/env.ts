function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  get MOTHERDUCK_TOKEN() {
    return required("MOTHERDUCK_TOKEN");
  },
  get MOTHERDUCK_DATABASE() {
    return process.env.MOTHERDUCK_DATABASE ?? "mayolo";
  },
  get AI_GATEWAY_API_KEY() {
    return process.env.AI_GATEWAY_API_KEY ?? "";
  },
  get APP_BASE_URL() {
    return process.env.APP_BASE_URL ?? "http://localhost:3000";
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
