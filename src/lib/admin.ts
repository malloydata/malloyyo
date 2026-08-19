// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import { type User } from "@/db";
import { env } from "./env";
import { getSessionUser, UnauthorizedError } from "./user";

export function isAdmin(user: User): boolean {
  // `role` is the authority where the application owns sign-in; where an
  // integration does, both `role` and `isAdmin` mirror the provider's claim
  // (src/lib/external-user.ts), so reading either is reading the provider.
  // `isAdmin` stays consulted because rows granted admin before the role
  // column existed carry it there.
  if (user.role === "owner" || user.role === "admin") return true;
  if (user.isAdmin) return true;
  // APP_ADMIN_EMAILS is an authorization convenience for someone already
  // authenticated and authorized — deliberately NOT break-glass (it cannot
  // admit anyone; see BREAK_GLASS_EMAIL in src/lib/authorize.ts for that).
  if (user.email && env.APP_ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}

// The admin gate for API routes: throws, so the route decides the response shape.
export async function requireAdmin(): Promise<User> {
  const me = await getSessionUser();
  if (!isAdmin(me)) throw new UnauthorizedError("not authorized");
  return me;
}

// The admin gate for pages: anyone who does not belong goes home. Every admin page calls
// this itself — the admin layout must not, because layouts are cached across client
// navigations and an auth check there silently stops running.
export async function requireAdminPage(): Promise<User> {
  let me: User;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/");
    throw err;
  }
  if (!isAdmin(me)) redirect("/");
  return me;
}
