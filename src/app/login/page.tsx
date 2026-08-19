// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The sign-in screen, when an integration owns sign-in.
//
// A shell: this file owns what is the application's business — refusing to exist when no
// integration is installed, sanitizing the callback URL, not showing a sign-in screen to
// somebody who already has a session, and the page frame — and renders the integration's
// screen for the part that is not. A deployment using the built-in providers has no
// integration, so this route 404s and NextAuth's own screen is used instead; it never
// becomes a second way in.

import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { env } from "@/lib/env";
import { safeCallbackUrl } from "@/lib/callback-url";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import HostedAuthFrame from "@/app/hosted-auth-frame";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ callbackUrl?: string }> };

export default async function LoginPage({ searchParams }: PageProps) {
  const integration = hostedIntegration();
  if (!integration) notFound();

  const { callbackUrl: raw } = await searchParams;
  const callbackUrl = safeCallbackUrl(raw);

  // Already signed in — don't show a sign-in screen to someone who has a session, or the
  // middleware's redirect and this page bounce a valid user back and forth. This checks the
  // application session only: an expired app session alongside a live integration session
  // falls through to the screen, which is where a silent renewal belongs.
  if ((await auth())?.user) redirect(callbackUrl);

  const Screen = integration.LoginScreen;
  return (
    <HostedAuthFrame>
      <Screen
        callbackUrl={callbackUrl}
        // Absolute, and built from this instance's own base URL: an integration's provider
        // generally requires a pre-registered redirect, and a relative one would not be.
        authenticateUrl={new URL("/authenticate", env.APP_BASE_URL).toString()}
      />
    </HostedAuthFrame>
  );
}
