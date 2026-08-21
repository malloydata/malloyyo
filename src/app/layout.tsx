// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { TelemetryPageView } from "@/components/TelemetryPageView";
import { env } from "@/lib/env";
import { telemetryPageTrackingEnabled } from "@/lib/telemetry";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: env.INSTANCE_NAME,
  description: "Point at a dataset URL, get a Malloy MCP endpoint.",
};

/** GA4, on every page of this instance, when ANALYTICS_ID is set. Unset means no
    third-party script and no cookies — the same default as a statically bundled
    site, which reads its ID from malloy-config.json instead. This is a server
    component, so the ID is read straight from the environment; no NEXT_PUBLIC_
    prefix is needed and nothing else leaks to the client. */
function Analytics({ id }: { id: string }) {
  if (!id) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`} strategy="afterInteractive" />
      <Script id="ga4" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('js',new Date());gtag('config',${JSON.stringify(id)});`}
      </Script>
    </>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {telemetryPageTrackingEnabled() ? <TelemetryPageView /> : null}
        <Analytics id={env.ANALYTICS_ID} />
      </body>
    </html>
  );
}
