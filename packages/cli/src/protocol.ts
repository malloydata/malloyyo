// Wire contract for the Malloyyo model-push endpoint.
//
// TODO(shared-types): once the server `POST /api/datasets/:dataset/model/push`
// route lands, lift these types into a `packages/protocol` workspace package and
// import them from BOTH the route handler and this CLI, so the contract has a
// single source of truth (the monorepo benefit — see docs/model-publishing-design.md §7).

export interface ModelFile {
  /** Path relative to the published directory, POSIX-separated. */
  path: string;
  content: string;
}

export interface GitInfo {
  /** "owner/name", best-effort from `origin`. Absent outside a git checkout. */
  repo?: string;
  branch?: string;
  /** Full commit SHA. */
  sha?: string;
  /** True if the working tree had uncommitted changes at publish time. */
  dirty?: boolean;
}

/** Body of POST /api/datasets/:dataset/model/push */
export interface PublishRequest {
  files: ModelFile[];
  /** Contents of malloy-config.json at the directory root, if present. */
  config?: string;
  git: GitInfo;
}

/** Response from both `model/push` and `model/status`. Mirrors the server's RefreshResult. */
export interface ModelStatus {
  ok: boolean;
  version?: number;
  sources?: Array<{ name: string; description?: string | null }>;
  compiledAt?: string | null;
  compileError?: string | null;
  git?: GitInfo;
  /** Set when ok === false. */
  error?: string;
}
