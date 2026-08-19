// Inferring which hosted instance a cloud verb means from the malloy-config.json in the
// working directory — the same context `login` and `publish` already resolve, extended to
// the cloud group so working inside a model repo does not require re-typing the instance
// on every secrets command.
//
// The one hazard that shapes this file: a config target may point at a *self-hosted*
// instance (`data.acme-corp.com`), and naively extracting its first hostname label would
// address a stranger's hosted instance with it. So inference only ever accepts a target
// under the hosted domain, and refuses everything else by naming the host it found.
//
// `instance delete` never infers, permanently: an implicit default on a destructive verb
// is where cleverness is least welcome (the control-plane contract records the
// decision and its revision).

import { resolveInstance } from "../config.js";

/** The domain every Malloyyo-hosted instance lives under. */
const HOSTED_DOMAIN_SUFFIX = ".malloyyo.com";

export type InferredInstance = {
  /** The instance's name — the first label of its hostname, what the control plane calls the slug. */
  readonly slug: string;
  /** Which config target it came from, for the announcement line. */
  readonly targetName: string;
};

export class InstanceInferenceError extends Error {}

/**
 * The instance the current directory's config points at.
 *
 * Throws `InstanceInferenceError` with an actionable message when the directory has no
 * config, the config is ambiguous (several targets with different URLs — same rule and
 * same wording as `login`), or the target is not a Malloyyo-hosted instance.
 */
export function inferInstance(dir: string): InferredInstance {
  let resolved: { name: string; url: string };
  try {
    resolved = resolveInstance(dir);
  } catch (error) {
    throw new InstanceInferenceError(
      `no instance given, and none could be inferred from malloy-config.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(resolved.url).hostname;
  } catch {
    throw new InstanceInferenceError(
      `no instance given, and the config target "${resolved.name}" has a URL this command cannot parse`,
    );
  }

  if (!hostname.endsWith(HOSTED_DOMAIN_SUFFIX)) {
    throw new InstanceInferenceError(
      `no instance given, and the config target "${resolved.name}" points at ${hostname}, ` +
        "which is not a Malloyyo-hosted instance — name the instance explicitly",
    );
  }

  const slug = hostname.slice(0, hostname.indexOf("."));
  if (slug === "") {
    throw new InstanceInferenceError(
      `no instance given, and the config target "${resolved.name}" points at the bare hosted domain`,
    );
  }
  return { slug, targetName: resolved.name };
}
