// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { ChatApp } from "@/components/ChatApp";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const sp = await searchParams;
  return <ChatApp initialChatId={sp.id} />;
}
