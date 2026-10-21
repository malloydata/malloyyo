// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The setup page's three steps. Each one works the same way on every platform
// up to the point a secret has to land in the environment: on Malloyyo Cloud
// this page saves it (testing first, since a save restarts the instance); on
// Vercel or Docker it names the variables for the operator to set, then tests
// what the running instance actually sees.

import { useEffect, useRef, useState } from "react";
import type { SetupStatus } from "@/lib/setup-status";
import { envNameFor, type ConnectionKindSpec } from "@/lib/connection-kinds";

type KindRow = ConnectionKindSpec & { kind: string };
type Props = {
  status: SetupStatus;
  kinds: KindRow[];
  manual: { authoring: string; github: string; webhook: string; connection: string };
  initial: { step: string; kind: string; name: string; repo: string; settings: Record<string, string> };
};

type Result = { ok: boolean; error?: string; config?: string; dialect?: string; ms?: number; [k: string]: unknown };

async function post(body: Record<string, unknown>): Promise<Result & { operation?: { id: string } | null }> {
  const res = await fetch("/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ ok: false, error: `request failed (${res.status})` }))) as Result;
}

/** Follow a Malloyyo Cloud secrets operation through the instance's restart. */
function useOperation() {
  const [state, setState] = useState<"idle" | "running" | "succeeded" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  function track(id: string | undefined) {
    if (!id) return setState("succeeded");
    setState("running");
    timer.current = setInterval(async () => {
      // The instance is restarting: a failed poll is expected for a while.
      const r = await fetch(`/api/admin/setup?operation=${id}`).catch(() => null);
      const out = (await r?.json().catch(() => null)) as { operation?: { status: string } } | null;
      const s = out?.operation?.status;
      if (s === "succeeded" || s === "failed") {
        setState(s);
        if (timer.current) clearInterval(timer.current);
      }
    }, 4000);
  }
  return { state, track };
}

const box = "rounded border border-gray-200 dark:border-gray-800 p-4 space-y-3";
const h2 = "text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400";
const input =
  "w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 font-mono text-xs";
const button =
  "rounded bg-black text-white dark:bg-white dark:text-black px-3 py-1.5 text-xs disabled:opacity-50";
const code = "rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono";

function Restart({ state }: { state: ReturnType<typeof useOperation>["state"] }) {
  if (state === "idle") return null;
  if (state === "running") return <p>Saved. The instance is restarting to pick it up — about a minute…</p>;
  if (state === "failed") return <p className="text-red-700 dark:text-red-300">The restart failed. Check the Secrets page.</p>;
  return <p className="text-green-700 dark:text-green-300">Done. Tell Claude it&apos;s set.</p>;
}

function Outcome({ r }: { r: Result | null }) {
  if (!r) return null;
  if (!r.ok) return <p className="text-red-700 dark:text-red-300 whitespace-pre-wrap">{r.error}</p>;
  return null;
}

export default function SetupClient({ status, kinds, manual, initial }: Props) {
  // Cloud and a local dev server both save secrets from this page.
  const cloud = status.platform === "cloud" || status.platform === "dev";
  const focus = (step: string) => (initial.step === step ? "ring-2 ring-blue-400" : "");

  // ── authoring ──
  const authOp = useOperation();
  const [authResult, setAuthResult] = useState<Result | null>(null);

  // ── connection ──
  const [kind, setKind] = useState(kinds.some((k) => k.kind === initial.kind) ? initial.kind : kinds[0].kind);
  const [name, setName] = useState(initial.name || "warehouse");
  const [settings, setSettings] = useState<Record<string, string>>(initial.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [connBusy, setConnBusy] = useState(false);
  const [connResult, setConnResult] = useState<Result | null>(null);
  const connOp = useOperation();
  const spec = kinds.find((k) => k.kind === kind)!;
  const envNames = spec.fields.filter((f) => f.secret).map((f) => envNameFor(name, f));

  async function connection(action: "test-connection" | "save-connection", literal: boolean) {
    setConnBusy(true);
    setConnResult(null);
    const r = await post({ action, kind, name, settings, ...(literal ? { secrets } : {}) });
    setConnBusy(false);
    setConnResult(r);
    if (r.ok && action === "save-connection") {
      setSecrets({});
      connOp.track(r.operation?.id);
    }
  }

  // ── github ──
  const [repo, setRepo] = useState(initial.repo);
  const [token, setToken] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghResult, setGhResult] = useState<Result | null>(null);
  const ghOp = useOperation();
  const [hook, setHook] = useState<string | null>(null);
  const hookOp = useOperation();
  const known = status.repos.find((r) => r.github && r.github.toLowerCase() === repo.trim().toLowerCase());

  async function github(action: "test-github" | "save-github") {
    setGhBusy(true);
    setGhResult(null);
    const r = await post({ action, repo, ...(token ? { token } : {}) });
    setGhBusy(false);
    setGhResult(r);
    if (r.ok && action === "save-github") {
      setToken("");
      ghOp.track(r.operation?.id);
    }
  }

  return (
    <div className="space-y-6 text-xs">
      <p className="text-gray-600 dark:text-gray-400">
        Setting up <strong>{status.instance}</strong>{" "}
        {status.platform === "dev" ? "on a local dev server: secrets you save here go in its dev secrets file and take effect at once." : cloud ? "on Malloyyo Cloud: secrets you save here are stored in the instance's environment, never shown again." : status.platform === "vercel" ? "on Vercel: secrets go in the project's Environment Variables." : "self-hosted: secrets go in the instance's environment."}{" "}
        Claude walks you through this; each step tells you when to come back.
      </p>

      {/* ── 1. Authoring ── */}
      <section id="authoring" className={`${box} ${focus("authoring")}`}>
        <h2 className={h2}>1 · Let Claude author models</h2>
        {status.authoring ? (
          <p className="text-green-700 dark:text-green-300">On. Claude&apos;s authoring tools are available to admins.</p>
        ) : cloud ? (
          <>
            <p>
              Authoring lets Claude preview and publish model code here, with this instance&apos;s connections. Turning it on restarts the instance once.
            </p>
            <button
              className={button}
              disabled={authOp.state === "running"}
              onClick={async () => {
                const r = await post({ action: "authoring" });
                setAuthResult(r);
                if (r.ok) authOp.track(r.operation?.id);
              }}
            >
              Turn on authoring
            </button>
            <Outcome r={authResult} />
            <Restart state={authOp.state} />
          </>
        ) : (
          <p>
            {"Off. "}
            <Md text={manual.authoring} />
            {" Previews compile model code with this instance's connections; see the docs on authoring security."}
          </p>
        )}
      </section>

      {/* ── 2. Connection ── */}
      <section id="connection" className={`${box} ${focus("connection")}`}>
        <h2 className={h2}>2 · Connect a database</h2>
        <div className="grid grid-cols-[8rem_1fr] gap-2 items-center max-w-xl">
          <label>Database</label>
          <select className={input} value={kind} onChange={(e) => (setKind(e.target.value), setConnResult(null))}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <label>Connection name</label>
          <input className={input} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          {spec.fields
            .filter((f) => !f.secret)
            .map((f) => (
              <FieldRow key={f.key} label={f.label} help={f.help}>
                {f.kind === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={(settings[f.key] ?? f.defaultValue ?? "false") !== "false"}
                    onChange={(e) => setSettings({ ...settings, [f.key]: String(e.target.checked) })}
                  />
                ) : (
                  <input
                    className={input}
                    placeholder={f.placeholder ?? f.defaultValue}
                    value={settings[f.key] ?? ""}
                    onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })}
                  />
                )}
              </FieldRow>
            ))}
          {spec.fields
            .filter((f) => f.secret)
            .map((f) => (
              <FieldRow key={f.key} label={f.label} help={`${f.help ? `${f.help} ` : ""}Stored as ${envNameFor(name, f)}.`}>
                {f.multiline ? (
                  <textarea
                    className={`${input} h-24`}
                    value={secrets[f.key] ?? ""}
                    onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                    autoComplete="off"
                  />
                ) : (
                  <input
                    type="password"
                    className={input}
                    value={secrets[f.key] ?? ""}
                    onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                    autoComplete="new-password"
                  />
                )}
              </FieldRow>
            ))}
        </div>
        <p className="text-gray-600 dark:text-gray-400">You&apos;ll need {spec.needs}.</p>
        {cloud ? (
          <div className="flex gap-2">
            <button className={button} disabled={connBusy} onClick={() => connection("save-connection", true)}>
              {connBusy ? "Testing…" : "Test & save"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p>
              <Md text={manual.connection.replace("{names}", envNames.join(", "))} />
            </p>
            <div className="flex gap-2">
              <button className={button} disabled={connBusy} onClick={() => connection("test-connection", true)}>
                Try these values
              </button>
              <button className={button} disabled={connBusy} onClick={() => connection("test-connection", false)}>
                Test what&apos;s set
              </button>
            </div>
          </div>
        )}
        <Outcome r={connResult} />
        {connResult?.ok ? (
          <div className="space-y-1">
            <p className="text-green-700 dark:text-green-300">
              Connected ({String(connResult.dialect)}, {String(connResult.ms)} ms). The config for malloy-config.json — Claude writes this for you:
            </p>
            <pre className={`${code} p-2 whitespace-pre overflow-x-auto`}>{connResult.config}</pre>
          </div>
        ) : null}
        <Restart state={connOp.state} />
      </section>

      {/* ── 3. GitHub ── */}
      <section id="github" className={`${box} ${focus("github")}`}>
        <h2 className={h2}>3 · Connect GitHub (publishing)</h2>
        <div className="grid grid-cols-[8rem_1fr] gap-2 items-center max-w-xl">
          <label>Repository</label>
          <input className={input} placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </div>
        <p>
          <strong>Token.</strong> Create a{" "}
          <a className="underline" target="_blank" rel="noreferrer" href="https://github.com/settings/personal-access-tokens/new">
            fine-grained personal access token
          </a>{" "}
          for <em>only this repository</em>, with <strong>Contents: Read-only</strong> (Metadata comes with it). Choose an expiry you&apos;ll remember. {status.github.tokenSet ? "A token is already set; a new one replaces it." : ""}
        </p>
        {cloud ? (
          <div className="flex gap-2 items-center max-w-xl">
            <input type="password" className={input} placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
            <button className={button} disabled={ghBusy || !repo || !token} onClick={() => github("save-github")}>
              {ghBusy ? "Testing…" : "Test & save"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p>
              <Md text={manual.github} />
            </p>
            <button className={button} disabled={ghBusy || !repo} onClick={() => github("test-github")}>
              Test the token that&apos;s set
            </button>
          </div>
        )}
        <Outcome r={ghResult} />
        {ghResult?.ok ? (
          <p className="text-green-700 dark:text-green-300">
            The token reads {String(ghResult.repo)} ({ghResult.private ? "private" : "public"}).
          </p>
        ) : null}
        <Restart state={ghOp.state} />

        <p className="pt-2">
          <strong>Webhook</strong> — so merging publishes.{" "}
          {status.github.webhookSecretSet ? "A webhook secret is already set; a new one replaces it (update GitHub too)." : ""}
        </p>
        {known ? (
          <>
            <button
              className={button}
              disabled={hookOp.state === "running"}
              onClick={async () => {
                const r = await post({ action: "webhook-secret", save: cloud });
                if (r.ok) {
                  setHook(String(r.secret));
                  if (cloud) hookOp.track((r.operation as { id: string } | null)?.id);
                }
              }}
            >
              {cloud ? "Create & save webhook secret" : "Create a webhook secret"}
            </button>
            {hook ? (
              <ol className="list-decimal pl-5 space-y-1">
                <li>
                  Open{" "}
                  <a className="underline" target="_blank" rel="noreferrer" href={`https://github.com/${known.github}/settings/hooks/new`}>
                    the repo&apos;s new-webhook page
                  </a>
                  .
                </li>
                <li>
                  Payload URL: <code className={code}>{known.webhookUrl}</code>
                </li>
                <li>
                  Content type: <code className={code}>application/json</code>
                </li>
                <li>
                  Secret: <code className={code}>{hook}</code> <span className="text-gray-500">(shown once — copy it now)</span>
                </li>
                <li>Events: just the push event. Then Add webhook.</li>
                {!cloud ? (
                  <li>
                    <Md text={manual.webhook} />
                    {" Use the same secret value."}
                  </li>
                ) : null}
              </ol>
            ) : null}
            <Restart state={hookOp.state} />
          </>
        ) : (
          <p className="text-gray-600 dark:text-gray-400">
            {repo ? `${repo} isn't registered on this instance yet — Claude registers it during setup.` : "Enter the repository above."}
          </p>
        )}
      </section>
    </div>
  );
}

function FieldRow({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <>
      <label>{label}</label>
      <div className="space-y-0.5">
        {children}
        {help ? <p className="text-gray-500">{help}</p> : null}
      </div>
    </>
  );
}

/** Platform instructions are written for chat too: render their `code` spans. */
function Md({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <code key={i} className={code}>
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
