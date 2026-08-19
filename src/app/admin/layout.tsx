// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The frame every admin page shares: the header and the section tabs.
//
// No auth check here, deliberately. A layout is cached across client-side navigations,
// so a check in this file silently stops running exactly where it looks like a guard —
// every admin page gates itself with requireAdminPage() instead. All this file could
// leak is tab labels, and the page's redirect discards its output anyway.

import type { ReactNode } from "react";
import Link from "next/link";
import { adminTabs } from "@/lib/admin-tabs";
import { env } from "@/lib/env";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import AdminTabs from "./AdminTabs";

export const runtime = "nodejs";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← all datasets
        </Link>
        <h1 className="text-xl font-bold mt-3">Admin · {env.INSTANCE_NAME}</h1>
      </header>
      <AdminTabs tabs={adminTabs(hostedIntegration())} />
      {children}
    </main>
  );
}
