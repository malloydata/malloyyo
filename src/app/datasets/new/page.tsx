// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";

export default function NewDatasetPage() {
  redirect("/datasets/new/github");
}
