// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AdminTab } from "@/lib/admin-tabs";

// The admin section tabs. A client component because the active pill follows the
// pathname on client-side navigations, which the (cached) layout cannot see.
export default function AdminTabs({ tabs }: { tabs: AdminTab[] }) {
  const pathname = usePathname();

  const isActive = (tab: AdminTab) =>
    tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

  // Active = the app's inverted black/white treatment, matching DatasetNav's pills.
  const pill = (active: boolean) =>
    `px-2.5 py-1 rounded-md transition-colors ${
      active
        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
        : "text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
    }`;

  return (
    <nav className="flex items-center gap-2 flex-wrap rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40 px-2.5 py-1.5 text-xs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pill(isActive(tab))}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
