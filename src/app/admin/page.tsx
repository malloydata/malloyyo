// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { requireAdminPage } from "@/lib/admin";
import { getSettings, SETTING_DEFAULTS } from "@/lib/settings";
import SettingEditor from "./SettingEditor";

export const runtime = "nodejs";

export default async function AdminPage() {
  await requireAdminPage();

  const settings = await getSettings();

  return (
    <>
      <section className="space-y-8">
        <SettingEditor
          field="tagline"
          label="Front-page message"
          description="Shown under the instance title on the front page. Leave blank to restore the default."
          initialValue={settings.tagline}
          defaultValue={SETTING_DEFAULTS.tagline}
        />
        <SettingEditor
          field="signinNotice"
          label="Sign-in notice"
          description="Shown next to the sign-in button for signed-out visitors. Leave blank to restore the default."
          initialValue={settings.signinNotice}
          defaultValue={SETTING_DEFAULTS.signinNotice}
        />
      </section>
    </>
  );
}
