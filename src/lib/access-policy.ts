// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Who may JOIN this instance — distinct from authorization (src/lib/authorize.ts),
// which asks about people already here. A visible, auditable instance setting
// rather than an environment variable: changing it is an admin action, not a
// redeploy.
//
//   open   — anyone who can authenticate becomes an active member on arrival.
//   invite — newcomers land `pending` until an admin approves them; an
//            invitation created ahead of arrival admits them immediately.
//
// Only meaningful where the application owns sign-in. Where an integration
// does, its provider is the admission rule and nothing reads this.

import { db, instanceSettings } from "@/db";
import { eq } from "drizzle-orm";
import { env } from "./env";

export type AccessPolicy = "open" | "invite";

export const ACCESS_POLICIES: readonly AccessPolicy[] = ["open", "invite"];

/**
 * The effective policy. Absent (fresh install) means `invite` — the safe
 * default costs the first operator nothing, because the first sign-in on an
 * empty instance becomes the owner (src/lib/admission.ts). Databases upgraded
 * from the EMAIL_ALLOW_LIST era have their equivalent recorded explicitly by
 * seeding (src/lib/access-upgrade.ts), so upgrading changes nobody's access.
 */
export async function getAccessPolicy(): Promise<AccessPolicy> {
  const [row] = await db
    .select({ accessPolicy: instanceSettings.accessPolicy })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceCode, env.INSTANCE_CODE))
    .limit(1);
  const v = row?.accessPolicy;
  return v === "open" ? "open" : "invite";
}

export async function setAccessPolicy(policy: AccessPolicy): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ instanceCode: env.INSTANCE_CODE, accessPolicy: policy })
    .onConflictDoUpdate({
      target: instanceSettings.instanceCode,
      set: { accessPolicy: policy, updatedAt: new Date() },
    });
}
