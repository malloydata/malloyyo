// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The pluggable-sign-in contract, pinned against accidental change.
//
// A build that installs an authentication integration depends on specific things in this
// repository: a module with a particular name, capabilities with particular signatures,
// and the route files Next mounts — the sign-in shells and the admin catch-alls. None of
// that is exercised by an ordinary build here —
// `hostedIntegration()` returns null, so every consumer takes the other branch and a
// contributor can rename, move, or reshape any of it with the whole suite still green.
//
// The break would then surface in a different repository, at image-build time, to somebody
// who did not make the change. These tests move that discovery here.
//
// What they cannot prove is that an integration *works*. That needs a real one, and it is
// checked by typechecking a composed tree during the tenant image build. These prove the
// sockets are where an integration expects them.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { ComponentType } from "react";
import type {
  HostedAdminPage,
  HostedAuthDeps,
  HostedAuthIntegration,
  HostedUser,
} from "./hosted-auth.js";
import { hostedSignIn } from "./hosted-auth-integration.js";
import { hostedIntegration } from "./hosted-auth-integration.js";
import type * as ExternalUser from "./external-user.js";
import type * as IntegrationSettings from "./integration-settings.js";

// ---------------------------------------------------------------------------------------
// Compile-time pins. These assert nothing at runtime; they fail `tsc` if a shape drifts,
// which is the point — a signature change is a type error, not a behavior change, and no
// runtime assertion would catch it.
// ---------------------------------------------------------------------------------------

// The capability the application lends must keep satisfying the slot it is lent into. If
// `findOrCreateExternalUser` gains a required argument, changes its input shape, or returns
// fewer fields, this stops compiling here rather than breaking an integration elsewhere.
//
// Type-only, deliberately: importing it for real would load `@/db`, which opens a database
// connection at module load, and this file must run in a suite that has no database.
const _capability: HostedAuthDeps["findOrCreateUser"] =
  undefined as unknown as typeof ExternalUser.findOrCreateExternalUser;

// The membership-mirror capabilities the integration's roster uses: the §6.4
// disable switch and the read-only local facts, both keyed on externalAccountId.
const _setUserDisabled: HostedAuthDeps["setUserDisabled"] =
  undefined as unknown as typeof ExternalUser.setExternalUserDisabled;
const _getUserFacts: HostedAuthDeps["getUserFacts"] =
  undefined as unknown as typeof ExternalUser.externalUserFacts;

// The settings capabilities, pinned the same way and for the same reason: the composed
// registration module lends exactly these two functions into exactly these two slots.
const _readSetting: HostedAuthDeps["readSetting"] =
  undefined as unknown as typeof IntegrationSettings.readIntegrationSetting;
const _writeSetting: HostedAuthDeps["writeSetting"] =
  undefined as unknown as typeof IntegrationSettings.writeIntegrationSetting;

// The seam must keep returning the declared type. A widened or narrowed return — say,
// dropping a screen from the integration type — fails here.
const _seam: () => HostedAuthIntegration | null = hostedIntegration;

// Admin pages stay optional: an integration that contributes none must keep satisfying
// the type, or every existing build of one breaks.
const _noAdminPages: HostedAuthIntegration =
  undefined as unknown as Omit<HostedAuthIntegration, "adminPages">;

// Renewal stays optional, and its property signature remains the generic Request boundary
// rather than growing a dependency on the application's Next.js instance.
const _noRenewal: HostedAuthIntegration =
  undefined as unknown as Omit<HostedAuthIntegration, "renewSession">;
const _renewal: NonNullable<HostedAuthIntegration["renewSession"]> =
  undefined as unknown as (request: Request) => Promise<HostedUser | null>;

// The user returned by the lent capability is exactly what renewal may return.
const _renewedUser: HostedUser =
  undefined as unknown as Awaited<ReturnType<HostedAuthDeps["findOrCreateUser"]>>;

// A page written against today's props must keep satisfying the slot. Growing
// HostedAdminPageProps keeps this compiling (components accept extra props); *removing*
// a prop existing pages rely on fails here rather than in the integration's repository.
const _adminPageComponent: HostedAdminPage["Component"] =
  undefined as unknown as ComponentType<{ actionUrl: string }>;

// ---------------------------------------------------------------------------------------
// Runtime pins.
// ---------------------------------------------------------------------------------------

test("this build installs no integration", () => {
  assert.equal(hostedIntegration(), null);
  assert.equal(hostedSignIn(), false);
  // The two are separate modules so the cheap question can be asked without reaching the
  // database. Nothing but this stops them drifting into disagreeing.
  assert.equal(hostedSignIn(), hostedIntegration() !== null);
});

// The route files Next mounts. A shell that is deleted, renamed, or moved leaves an
// integration with nowhere to render, and nothing else here would notice: the pages are
// resolved from the filesystem at build time, not imported by any module a test reaches.
//
// The paths are duplicated from the filesystem on purpose. That is the whole assertion —
// deriving them from a directory listing would agree with any rename.
test("every route an integration mounts into exists", () => {
  for (const path of [
    "src/app/login/page.tsx",
    "src/app/reauth/page.tsx",
    "src/app/login/recover/page.tsx",
    "src/app/logout/page.tsx",
    "src/app/authenticate/page.tsx",
    "src/app/api/auth/handoff/route.ts",
    "src/app/admin/x/[slug]/page.tsx",
    "src/app/api/admin/x/[slug]/route.ts",
  ]) {
    assert.ok(
      existsSync(path),
      `${path} is gone. An integration mounts a screen there; moving or renaming it means ` +
        `a hosted build has nowhere to render and fails in another repository.`,
    );
  }
});

// The one file a hosted build replaces. Its *path and export name* are the contract — the
// compose script writes over exactly this path and the application imports exactly this
// name, so a rename here produces an image whose sign-in is silently the built-in one.
test("the substituted seam module keeps its path and export", () => {
  assert.ok(existsSync("src/lib/hosted-auth-integration.ts"));
  assert.equal(typeof hostedIntegration, "function");
  assert.equal(
    hostedIntegration.name,
    "hostedIntegration",
    "the hosted build replaces this module and calls this export by name",
  );
});
