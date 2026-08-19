// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Account recovery for a deployment whose integration can lock its own administrator out.
//
// A shell: it exists only where an integration owns sign-in, and renders that
// integration's screen. See src/lib/hosted-auth.ts.

import { notFound } from "next/navigation";
import { safeCallbackUrl } from "@/lib/callback-url";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import HostedAuthFrame from "@/app/hosted-auth-frame";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ callbackUrl?: string }> };

export default async function Page({ searchParams }: PageProps) {
  const integration = hostedIntegration();
  if (!integration) notFound();
  const { callbackUrl: raw } = await searchParams;
  const Screen = integration.RecoverScreen;
  return (
    <HostedAuthFrame>
      <Screen callbackUrl={safeCallbackUrl(raw)} />
    </HostedAuthFrame>
  );
}
