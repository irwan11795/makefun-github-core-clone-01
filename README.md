# github-core-clone-01 — v1 forge

<!-- SPDX-License-Identifier: MIT -->

A standalone GitHub-compatible git forge in one Node process, standard library only.
No git binary, no package manager, no outside service, no network at runtime.

## Run

```
node --experimental-strip-types main.ts
```

The entry point binds an ephemeral port (`listen(0)` — never 8080), POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done`
until the env says the trial is over and exits 0. Without `MAKEFUN_ENV_URL` it
exits 1 at once.

## What it serves (one in-memory store, one HTTP server)

- **Git smart HTTP** — upload-pack protocol v2 (`fetch`, `ls-refs`, `object-format=sha1`)
  and v0, receive-pack v0 with `report-status` / `side-band-64k` / `delete-refs`.
  Full packfile reader (v2/v3, OFS_DELTA + REF_DELTA) and writer (v2, full objects).
  Clone, incremental fetch, shallow fetch (depth / deepen), push with fast-forward
  enforcement (`non-fast-forward` refusals), branch/tag create/delete, mixed pushes.
- **REST v3** — repos (create/get/patch/delete, pagination, `Link rel="next"`),
  branches, commits, git refs, contents (create/update/delete with sha checks),
  labels, issues (create/list/get/patch/comments), pull requests (create/list/get/
  files/merge with three-way squash merge and 405 on conflict). Every reply is
  JSON with a non-empty `X-GitHub-Request-Id`; unknown routes are JSON 404;
  malformed JSON is 400; missing token is 401.
- **GraphQL** (`POST /api/graphql`) — a recursive-descent parser for the queries
  `gh` and `github-mcp-server` send, with introspection (`__type` for Issue,
  PullRequest, Repository, SearchType), `viewer`, `repository`, `node` (global ids),
  cursor pagination, and mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`). Batched operations
  (JSON array) answered in order. Unknown repo returns `data.repository = null`.
- **MCP** (`POST /mcp`, JSON-RPC 2.0 Streamable HTTP) — modern `server/discover`
  (2026-07-28) plus legacy `initialize` / `notifications/initialized`, and
  `tools/list` / `tools/call` for `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`. Tools act on the
  same store as REST. No token → 401; non-JSON → 400 / `-32700`; unknown tool →
  `-32602`; missing required args → `isError: true`.

## Determinism

All timestamps are derived from a monotonic counter (`1,700,000,000 + seq`),
never the wall clock. The viewer is fixed (`adaiversen`, id 1000). Repository /
issue / pull / comment ids are sequential. The same sequence of operations
produces the same state.

## Layout

- `main.ts` — entry point (lifecycle only; imports `app.ts`).
- `app.ts` — the whole forge: git objects/packs, store, REST, GraphQL, MCP, router.
- `package.json` — `{ "type": "module", "engines": { "node": ">=22" } }` (no deps).
- `tsconfig.json` — strict, Node 22, `module: nodenext`.

## Local grading

```
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <repo-dir> --driver process
```

## License

MIT — see `LICENSE`.
