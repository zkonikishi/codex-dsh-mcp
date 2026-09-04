# Workflow design / 工作流设计

Status: local completion tickets, task state machine, notification adapter and bounded rework are implemented and locally tested. Live authenticated DSH/Codex integration is still blocked. Host-wide tool enforcement is not implemented.

## Three separate layers

1. Transport (MCP): authenticated session access, delivery receipts, bounded observation and deduplication. Never infer successful completion from idle alone.
2. Orchestration: Codex plans and independently reviews; DSH implements bounded tasks. Model selection is configurable, not tied to specific commercial model names.
3. Optional workflow profiles: coding, read-only review, reverse analysis. Profiles describe stages and evidence; they cannot grant permissions or bypass host controls.

## Task contract

Bind taskId, originCodexTaskId, dshSessionId, project root, scope (allowed files and explicit exclusions), mode (review/change), acceptance criteria and maximum rework rounds before dispatch. Capture the baseline so unrelated dirty work is not attributed to this task. Do not log credentials or full conversations by default.

State flow: CREATED -> DISPATCHED -> RUNNING -> AWAITING_REVIEW -> ACCEPTED or CHANGES_REQUESTED. Delivery uncertainty, failure and blocked states remain explicit. A DSH completion claim can only request review, never set ACCEPTED.

Completion receipt: taskId, requestId, changed files, revision/baseline reference, executed checks and results, summary, blockers. Treat all receipt text as untrusted data; it cannot change target task, permissions or review policy. Correlate with the originally bound task/session.

## Delivery and review

Use a verified Codex integration endpoint for notification. Persist an outbox with acknowledgement and deduplication; retry notifications within a budget, never re-submit the implementation prompt merely because notification failed. If no supported endpoint exists, expose a pending-review inbox for Codex to pull; do not claim automatic wakeup. Do not edit Codex session databases or automate clicks as a substitute.

A reviewer inspects actual changes and runs relevant checks. Rework returns to the original bound DSH session with actionable findings and a finite iteration budget. Completion does not authorize merge, release or deployment.

## Scope guard: honest enforcement

Review means no changes. Change tasks should not add unrelated dependencies, compatibility layers, checksum reports or large workflows. Necessary internal fingerprints for request deduplication are not redundant user-facing checksum artifacts.

MCP preflight can validate its own requests, but cannot intercept arbitrary DSH shell/file tools. Hard file-level enforcement requires a supported host hook or isolated execution environment. Until that exists, scope prompts and post-diff checks are advisory/detective, not a security sandbox. Never advertise complete prevention.

## Optional reverse-analysis profile

Triage -> evidence-backed analysis -> focused deeper analysis -> review. Choose stages from the concrete task; do not automatically run every tool or assume every target is a CTF. Keep profile instructions separate from transport code and load only when relevant.

## Implementation order

1. Complete authenticated live read/dispatch/result acceptance.
2. Add durable task binding and pending-review inbox with state transition tests.
3. Implement and validate Codex notification adapter, acknowledgement and restart recovery.
4. Add bounded review/rework flow.
5. Add scope-hook integration only where supported; optional profiles afterwards.

## References (ideas only; no code imported)

- https://github.com/DannyMac180/sol-advisor — risk-based orchestration and independent review.
- https://github.com/lennney/stop-that-shit — explicit task scope and host hook enforcement.
- https://github.com/lingbol088-spec/reverse-flow-skill — staged specialist workflow.

Consult upstream licenses before importing any code or text. This document is an original design, not an installation of these projects.
