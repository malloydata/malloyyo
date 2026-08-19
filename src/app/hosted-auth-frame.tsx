// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The frame every mounted sign-in screen sits in.
//
// The application owns the page and the integration owns what goes in the middle of it, so
// centring, width, and the instance heading belong here rather than in a contributed
// component — an integration that had to lay out its own page would be deciding how this
// application looks.
//
// It exists because the shells were first written without it: /login had the frame inline
// and the other three rendered a bare component, which put a sign-in card in the top-left
// corner of an empty page. One frame, used by all four, is what stops that recurring.

import type { ReactNode } from "react";
import { env } from "@/lib/env";

export default function HostedAuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <h1 className="mb-8 text-center font-mono text-xl font-bold">{env.INSTANCE_NAME}</h1>
      {children}
    </main>
  );
}
