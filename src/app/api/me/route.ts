import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, users } from "@/db";
import { eq } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ user: null });
  const [u] = await db.select().from(users).where(eq(users.id, session.user.id));
  return NextResponse.json({
    user: u
      ? { id: u.id, name: u.name, email: u.email, image: u.image, slug: u.slug, isAdmin: isAdmin(u) }
      : null,
  });
}
