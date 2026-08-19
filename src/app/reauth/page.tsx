// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A non-interactive browser fallback when the server could not renew the application
// session from the provider JWT. The integration rehydrates its own session and either
// signs back in or sends a genuinely signed-out visitor to /login.

import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { safeCallbackUrl } from "@/lib/callback-url";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import HostedAuthFrame from "@/app/hosted-auth-frame";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ callbackUrl?: string }> };

export default async function ReauthPage({ searchParams }: PageProps) {
  const integration = hostedIntegration();
  if (!integration) notFound();

  const { callbackUrl: raw } = await searchParams;
  const callbackUrl = safeCallbackUrl(raw);
  if ((await auth())?.user) redirect(callbackUrl);

  const Screen = integration.RenewScreen;
  return (
    <HostedAuthFrame>
      <Screen callbackUrl={callbackUrl} />
    </HostedAuthFrame>
  );
}
