"use client";

// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { usePathname } from "next/navigation";
import { useEffect } from "react";

export function TelemetryPageView() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    void fetch("/api/telemetry/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pathname }),
      keepalive: true,
    });
  }, [pathname]);

  return null;
}
