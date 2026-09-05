# Operation / 使用与恢复

## Setup

Requires Node 22+, PowerShell 7.2+, Windows DSH Web, and a Codex CLI exposing `app-server proxy` connected to the intended running app-server. No Docker is needed.

1. Copy `examples/config.example.json` OUTSIDE this checkout. Replace example executable, CLI, socket and project paths. Set `DSH_MCP_CONFIG` to its absolute path.
2. Protect the config/state directories so only your OS account can read/write them. The auth helper protects its own auth subdirectory; it does not change the ACL of arbitrary existing state trees.
3. Start/use the DSH Web installation matching configured argv: `node <cli> web --port <port> --no-open --host 127.0.0.1`. Other launch layouts require an adapter update. Do not restart an existing busy DSH instance.
4. Run `configure-auth.ps1` in PowerShell. Paste the authorized startup URL locally into the hidden prompt. It is never a shell argument. After DSH restarts, re-import its new startup token if required.
5. Ensure the configured Codex proxy socket belongs to the intended app-server. The bridge never starts a replacement server, edits session databases, or silently resumes the task in a second process. Desktop-only stdio processes may not expose a proxy socket. If so, use the pending inbox until a supported shared control endpoint is configured; do not claim automatic desktop wakeup.
6. Run `node doctor.mjs`. Live readiness requires authenticated DSH plus Codex active/idle, not merely an open port.

MCP command: your Node executable. Args: absolute path to `server.mjs`. Env: `DSH_MCP_CONFIG`, and optional TEMP/TMP. On hosts without CODEX_THREAD_ID, configure reviewerThreadId for ONE dedicated reviewer task; do not reuse that fixed identity across unrelated tasks.

Important: MCP does not standardize per-call Codex task identity. This implementation binds to the process-start identity, not a magically authenticated identity for every desktop caller. Use one dedicated reviewer per bridge instance. Multi-task hosts must supply a trusted per-task launcher; do not share a reviewer instance across different tasks and expect automatic destination switching.

## Workflow

- `dsh_sessions` / `dsh_history`: choose an existing correct project session.
- `workflow_dispatch`: supply taskId, dshSessionId, projectPath, scope, acceptance and text; optional maxRounds 1..5 (default 2). The original Codex task comes from its trusted local environment, not from DSH.
- Dispatch records Git HEAD and pre-existing status when available; an unavailable baseline is explicitly marked. This snapshot is review context, not filesystem enforcement.
- The dispatch prompt includes a report command and a private ticket path. DSH writes the JSON report and runs that command. It does not need the Codex endpoint or DSH credential file.
- `autoRunner=true` starts one detached worker on dispatch. Alternatively run `node runner.mjs` in a managed terminal; `--once` performs a single scan. Worker lifetime is independent of an MCP request. No login-startup task is installed.
- Worker verifies the completion ticket and queues tool output to the bound Codex task using the official app-server protocol. Idle alone never counts as completed.
- `workflow_status`: inspect actual delivery/notification states. `workflow_review`: accept or request changes after independent inspection. A changes decision sends bounded feedback to the same DSH session, up to maxRounds.
- `workflow_archive`: archive an accepted task and release the 256 active-record limit. Archived IDs cannot be reused. Private archives remain on disk until deliberately removed by the operator.

DSH must actually run the report command. A model that stops without reporting is not automatically classified as successful; the task becomes BLOCKED at its deadline (default 24 hours).

## Recovery

- Restart `runner.mjs` after machine restart; persisted pending records are rescanned.
- Notification PENDING/RETRY: definite pre-send failures retry with backoff, maximum five attempts.
- Notification UNKNOWN: the request may already have arrived. Inspect the bound Codex history for taskId + round. Use `workflow_resolve_notification` with notes and acknowledged or retry. Retrying without inspection can duplicate a model turn.
- Task DELIVERY_UNKNOWN: inspect DSH history and work. Repeating workflow_dispatch with the same task ID only returns its state; it never resubmits. A valid completion ticket can still advance it to review.
- A crashed writer/runner may leave a lock. Inspect recorded PID and actual process command/start time before removing only that stale lock. Do not steal locks automatically or kill unrelated processes.
- Expired/invalid authentication: import a legitimate new credential. Do not delete task state to work around it.
- Stop the foreground runner with Ctrl+C. Closing a bridge proxy never stops the shared Codex daemon or DSH tasks. Detached service management is left to the operator; the project installs no global service.

## Roles and optional profiles

`role=worker` exposes read-only DSH operations and denies reviewer/write calls at execution. This is an accidental-misuse guard, not a same-user security boundary. Configure DSH completion via the per-task report command rather than sharing a reviewer MCP connection.

The optional companion skill describes coding/review/specialist phases. It is advisory: no host hooks or full filesystem enforcement are installed.

## Proxy transport correction (2026-09-05)

The shared Codex `app-server proxy` transports an HTTP WebSocket Upgrade and
WebSocket frames, not JSONL. `ProxyRpcClient` uses Node WebSocket over a one-use
IPv4 loopback relay to the owned proxy subprocess. It never starts another
app-server or resumes an unloaded task. Closing the connection closes only its
relay/proxy, not the shared daemon. Direct stdio JSONL tests are not evidence for
this transport.

Regression evidence: 28 tests passed, including an actual subprocess WebSocket
handshake and masked request/response, plus failed-proxy cleanup. These are local
fixtures, not desktop acceptance. The current host still reports DSH_AUTH_REQUIRED
and an unavailable Codex proxy; automatic desktop review wakeup remains unverified.
Browser text/image collection previously passed with an agent driving the browser;
a standalone unattended browser worker is not implemented.

Protocol reference: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### Readiness diagnosis
`doctor.mjs` distinguishes missing authorization configuration, missing credential
file, missing control socket, connection failures and unloaded reviewer. It exits
nonzero unless both services are live. It never reads browser credentials or
starts a replacement app-server. Local regression suite: 31 passing tests.
