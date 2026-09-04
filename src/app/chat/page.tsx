// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { ChatApp } from "@/components/ChatApp";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; dataset?: string; source?: string }>;
}) {
  const sp = await searchParams;
  // `?dataset=&source=` starts a chat on that source and opens it — what the
  // Chat buttons elsewhere link to, so they land in a conversation rather than
  // in the picker with the answer already known.
  return <ChatApp initialChatId={sp.id} initialDataset={sp.dataset} initialSource={sp.source} />;
}
