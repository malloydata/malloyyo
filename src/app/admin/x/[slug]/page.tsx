// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A contributed admin page, when an integration contributes any.
//
// A shell: this file owns what is the application's business — refusing anyone who is
// not an administrator, and deciding what mounts where — and renders the integration's
// page for the part that is not. One dynamic route serves every contribution, because
// the set is open-ended: a new page must never need a new file here. A deployment with
// no integration, or no page at this slug, 404s exactly like the sign-in shells.

import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin";
import { hostedIntegration } from "@/lib/hosted-auth-integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export default async function AdminExtensionPage({ params }: PageProps) {
  // Gate before looking anything up: someone who does not belong learns nothing about
  // which pages exist, or whether an integration does.
  await requireAdminPage();

  const { slug } = await params;
  const page = hostedIntegration()?.adminPages?.find((p) => p.slug === slug);
  if (!page) notFound();

  const Page = page.Component;
  return <Page actionUrl={`/api/admin/x/${encodeURIComponent(slug)}`} />;
}
