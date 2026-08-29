// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The `<>` mark for "write a query". One definition because it now labels the
// same action in three places — the dashboard nav, a source row on the home
// page, and a source's menu — and three hand-drawn copies would drift.

export function QueryIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 6l-5 6 5 6" />
      <path d="M16 6l5 6-5 6" />
    </svg>
  );
}
