// Every HTTP call the CLI makes to a Malloyyo-operated server goes through
// here, so there is one place that identifies the client and one place that
// recognizes "this CLI is too old".
//
// A server is upgraded on its operator's schedule; the CLI is a global npm
// install upgraded on the user's, or not at all. "Old client, newer server" is
// therefore the normal condition rather than a mistake: servers stay backward
// compatible, and this header is how they can see which CLI versions are still
// in the field before changing anything.
import { version as VERSION } from "../package.json";

/** Sent on every request to a Malloyyo-operated server. */
export const USER_AGENT = `malloyyo/${VERSION}`;

/** The one status a server uses to say the CLI is below its supported floor. */
const UPGRADE_REQUIRED = 426;

async function upgradeRequiredMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { minimum_version?: string };
  const needs = body.minimum_version ? ` ${body.minimum_version} or newer` : " a newer version";
  return (
    `This server requires${needs} of the malloyyo CLI (you have ${VERSION}).\n` +
    `Run:  npm i -g @malloydata/malloyyo`
  );
}

/**
 * `fetch` for Malloyyo servers: adds the user agent, and turns an
 * upgrade-required response into an instruction the customer can act on rather
 * than a validation error they have to decode.
 *
 * Every other status is returned untouched — callers report their own failures,
 * and handling them here would hide ordinary 4xx/5xx detail.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", USER_AGENT);
  const res = await fetch(url, { ...init, headers });
  if (res.status === UPGRADE_REQUIRED) throw new Error(await upgradeRequiredMessage(res));
  return res;
}
