# ADR-0015: Token-Authenticated Loopback Workbench Shell

Status: **Accepted**
Date: 2026-08-21

## Context

The canonical store and CLI expose substantial research functionality, but a
researcher must currently read and author JSON to inspect a project. The
product contract requires a project navigator, research surface, object and
claim inspector, and activity view. A first UI must not create a second source
of truth, weaken exact-version evidence semantics, or imply that polished
presentation is verification.

ADR-0002 names Tauri and React as the intended complete desktop stack. Shipping
a pretend native shell or adding that dependency chain before the interaction
contract is exercised would make the current capability less honest and more
expensive to run. A browser can provide the desktop-ready local surface while
the same typed store APIs remain the semantic boundary.

## Decision

Add a dependency-light `@reasoning-workbench/workbench` package with a Node
HTTP server and bundled vanilla HTML, CSS, and JavaScript UI.

- The server always binds IPv4 `127.0.0.1`; callers cannot configure another
  interface.
- Every launch generates an independent 256-bit random session token. The CLI
  places it in the launch URL fragment, which is not sent in the initial HTTP
  request. The UI moves it to `sessionStorage` and sends it as a bearer token
  for every `/api/` request.
- The server rejects non-loopback peers, unexpected `Host` values, foreign
  `Origin` values, path traversal, backslashes, malformed encoding, oversized
  bodies, and non-JSON mutations. Static assets come from a closed in-memory
  map rather than caller-controlled filesystem paths.
- API reads are derived from canonical store projections and histories. UI
  selection, filters, tabs, and session tokens are never project state.
- Mutations reuse `createBranch` and `putObject`. The narrow initial surface
  creates isolated branches and a safe list of typed objects. It does not
  merge, publish, execute tools, spend, or accept an actor identity from the
  client.
- HTTP mutations are serialized per resolved project root within the local
  process. Branch-name uniqueness is checked inside that boundary; duplicate
  names return `409`, while missing branch targets return `404`. Cross-process
  multi-writer coordination remains outside this shell's authority boundary.
- Possession of the launch token is treated as local administrative authority.
  The server stamps one fresh trusted `human` actor ID per launch. The user who
  can start the process and write the project directory is already an
  administrator; this is not multi-user authentication or a sandbox boundary.
- Claim creation requires a visible context ID. Verification dimensions remain
  separate and the UI labels missing, supported, verified, failed,
  inconclusive, mixed, and stale states distinctly. Aggregate claim status is
  conservative (`failed` before `stale` before `inconclusive`/`mixed`); one
  verified dimension cannot mark a claim verified. Only a future profile that
  explicitly identifies its full required dimensions can produce that
  aggregate. Project integrity verification is displayed separately from claim
  assurance.

The command `rw workbench <project-dir>` serves and opens the UI. `--no-open`
supports headless/manual use and `--port` chooses a loopback port. This is an
honest browser-hosted local shell, not a shipped Tauri binary.

## Consequences

- Existing projects become usable without editing JSON, with no framework or
  network dependency and no change to the open canonical format.
- Progressive disclosure is reversible from cockpit summaries to exact
  object versions, hashes, content, edges, evidence, and history.
- Browser security is defense in depth around a local administrative process.
  Other software running as the same OS user may still read project files or
  inspect that user's processes; stronger isolation needs a native shell and
  operating-system security work.
- The API is intentionally local and single-user. Collaborative deployment,
  session persistence, native file pickers, rich editors, Tauri packaging,
  arbitrary updates, branch merge, and execution controls remain separate
  work.

## Rejected alternatives

- **UI-owned or browser-local canonical state:** violates invariant
  `INV-STATE-02` and
  would diverge from event history.
- **Unauthenticated localhost API:** vulnerable to unrelated browser pages and
  local applications issuing project mutations.
- **Client-supplied actor IDs:** allows attribution spoofing and confuses local
  administrative authority with identity authentication.
- **Binding all interfaces for convenience:** silently turns a desktop surface
  into a network service without a deployment security model.
- **Calling the browser shell Tauri:** overstates what the repository ships.
