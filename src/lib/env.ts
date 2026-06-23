// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

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
  // When enabled, the sign-in screen offers a "Continue anonymously" button
  // that mints a throwaway slug-only user (no email) with a Heroku-style name.
  // Gates CREATION of anonymous sessions only — once a session exists it's a
  // valid user everywhere (web + MCP).
  //
  // DELIBERATELY NON-PORTABLE. The value must NAME this instance — i.e. equal
  // its INSTANCE_CODE (e.g. ALLOW_ANONYMOUS=worldcup), not a generic "true".
  // This way the flag can't ride along on a copied env: pasted onto another
  // instance (different INSTANCE_CODE) it is inert, so anonymous access never
  // turns on by accident. Defense in depth:
  //   - a truthy-but-mismatched value is IGNORED and warned about (the
  //     copy-paste signal), and
  //   - an instance with an EMAIL_ALLOW_LIST is invite-only and can NEVER be
  //     anonymous (fail closed).
  get ALLOW_ANONYMOUS(): boolean {
    const raw = (process.env.ALLOW_ANONYMOUS ?? "").trim().toLowerCase();
    if (!raw) return false;
    if (raw !== this.INSTANCE_CODE) {
      console.warn(
        `[security] ALLOW_ANONYMOUS=${raw} ignored: it must equal INSTANCE_CODE=` +
          `${this.INSTANCE_CODE} to enable anonymous access on this instance. ` +
          `A non-matching value usually means a copied env — anonymous stays OFF.`,
      );
      return false;
    }
    if ((process.env.EMAIL_ALLOW_LIST ?? "").trim()) {
      console.warn(
        "[security] ALLOW_ANONYMOUS ignored: EMAIL_ALLOW_LIST is set, so this " +
          "instance is invite-only and cannot also be anonymous. Remove the " +
          "allow-list to enable anonymous access.",
      );
      return false;
    }
    return true;
  },
};
