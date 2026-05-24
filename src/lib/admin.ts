import { type User } from "@/db";
import { env } from "./env";

export function isAdmin(user: User): boolean {
  if (user.isAdmin) return true;
  if (user.email && env.APP_ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}
