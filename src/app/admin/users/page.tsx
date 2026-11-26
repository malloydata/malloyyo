// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The Users tab is now part of Users & roles (src/app/admin/roles/page.tsx):
// one row per person, with their roles, what those add up to, and whether they
// may sign in. This route stays so that links and bookmarks to it keep working.
// The controls it used to host are still next door, in ./roster-controls.

import { redirect } from "next/navigation";

export default function AdminUsersPage() {
  redirect("/admin/roles");
}
