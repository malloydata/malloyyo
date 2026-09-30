// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import { type User } from "@/db";
import { hasRole, MALLOYYO_ADMIN } from "./roles";
import { getSessionUser, UnauthorizedError } from "./user";

export function isAdmin(user: User): boolean {
  // Defined in terms of the role list rather than beside it. rolesOf() folds in
  // every older way of being an admin — the `role` column, the `isAdmin` flag an
  // integration mirrors from its provider, and APP_ADMIN_EMAILS — so this answer
  // and the Roles page always name the same people.
  return hasRole(user, MALLOYYO_ADMIN);
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
