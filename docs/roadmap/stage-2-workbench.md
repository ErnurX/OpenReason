# Stage 2 Local Workbench Slice

Date: 2026-08-21
Status: **Implemented; acceptance tests defined**

## Outcome

The local workbench makes an existing Reasoning Workbench project usable
through a real browser UI while preserving the open event-sourced project as
the only canonical state. It is a desktop-ready local shell served by Node,
not a native Tauri distribution.

Launch it with:

```bash
pnpm rw workbench /path/to/reasoning-project

# Do not open a browser automatically; select an available loopback port.
pnpm rw workbench /path/to/reasoning-project --no-open --port 0
```

The launch command prints the exact `http://127.0.0.1:<port>/#token=...` URL.
The process runs until interrupted. Treat this URL as a short-lived local
administrative credential and do not share it.

## Delivered surfaces

- Project header with branch selection, search/filter, project integrity
  status, and create actions.
- Navigator groups for problem and goals, workstreams, branches, claims and
  context, sources, artifacts and runs, and documents.
- Research Surface overview, readable typed-object view, and document view.
- Claim/Object Inspector with exact version ID, content hash, typed content,
  evidence and dependency edges, multidimensional verification status, and
  complete object history.
- Activity panel with recent canonical events, runs/workstreams, durable
  failures, and unresolved states.
- Clear styling for working/proposal, supported, verified, failed,
  inconclusive, mixed, stale, paused, blocked, and completed states. A claim is
  never aggregated as verified from one verified dimension.
- Forms for isolated branch creation and typed project objects. Claim forms
  require an existing context; users never need to author JSON.

## Local API

All `/api/` routes require `Authorization: Bearer <launch-token>`.

| Method | Route | Meaning |
|---|---|---|
| `GET` | `/api/workspace?branch=<id-or-name>` | Branch-visible objects, edges, artifacts, recent events, verification profiles, and counts |
| `GET` | `/api/objects/<object-id>?branch=<id-or-name>` | Exact current version, content, edges, verification profile, and full history |
| `GET` | `/api/verification` | Canonical event/artifact/projection integrity report |
| `POST` | `/api/branches` | Create a direct child branch through the canonical store |
| `POST` | `/api/objects` | Create one allowed typed object through the canonical store |

The API deliberately has no route for arbitrary files, actors, merge,
publication, execution, network access, or spend. Filesystem write access and
the ability to launch this process are local administrative authority. Local
HTTP mutations are serialized per project; duplicate branch names return
`409`, and missing branch targets return `404`.

## Acceptance traceability

| ID | Acceptance rule | Automated evidence |
|---|---|---|
| WB-AC-01 | Service binds only `127.0.0.1` and each launch has a fresh high-entropy token. | `packages/workbench/test/server.test.ts` loopback/token test |
| WB-AC-02 | API rejects missing/incorrect auth, foreign origins, unsafe paths, and client actor spoofing. | API auth, traversal, origin, and actor tests |
| WB-AC-03 | RP-001 can be read by branch and inspected down to an exact version, hash, edges, and history. | RP-001 workspace/object read test (`DOD-REF-04`) |
| WB-AC-04 | A user can create a branch and durable typed object without editing JSON. | Mutation integration test plus static form contract |
| WB-AC-05 | Required navigator, research, inspector, activity, verification, search, and status surfaces ship together. | Static UI contract test |
| WB-AC-06 | UI state is non-canonical and all durable writes use existing typed store APIs. | Server integration tests inspect accepted events and trusted attribution |
| WB-AC-07 | Switching branches clears exact-version selection immediately and stale responses cannot repopulate another branch's inspector. | Executable browser-state generation/detail regression |
| WB-AC-08 | Claim status uses conservative dimension precedence and requires an explicit full required profile for aggregate verification. | Executable claim aggregation table test |
| WB-AC-09 | Concurrent duplicate branch creates produce one branch and one `409`; missing branches are not server errors. | Concurrent mutation and missing-branch API tests |

Run focused acceptance with:

```bash
pnpm vitest run packages/workbench/test/server.test.ts
```

Run the repository gate with `pnpm run check`.

## Honest limitations

- This is a browser-hosted local shell, not a Tauri app, installer, or native
  desktop binary.
- The initial authoring surface creates typed objects but is not a structured
  working-paper editor, graph canvas, or conflict-resolution UI.
- The server is single-user and local-only. It provides no TLS, remote access,
  collaborative identities, or authorization roles.
- The token protects the HTTP surface from casual cross-origin/local requests;
  it is not protection from an attacker with the same OS-user privileges.
- Search is client-side lexical filtering over the loaded branch projection.
  The initial response and 250-event activity window are intended for current
  local projects; pagination/virtualization are future scaling work.
- A green project integrity report proves structural replay and hashes, not a
  mathematical claim. Claim assurance remains dimension-specific.
