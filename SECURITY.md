# Security / 安全边界

This is a local same-user automation bridge, not a sandbox against malicious processes running as the same OS user.

- Keep config, auth and workflow state outside the source checkout, protected by current-user filesystem permissions. On Windows use the auth helper and a private state directory; on POSIX use mode 0700/0600.
- Never commit launch URLs, cookies, tickets, completion payloads, project history or private task results.
- DSH credentials are operator supplied; no browser database, renderer secret or signing-key extraction is implemented.
- Completion tickets authorize only a bound task/round report. Reports cannot select a destination, approve a task, change permissions or trigger arbitrary RPC. Reports remain untrusted even after MAC verification.
- Reviewer identity comes from the locally trusted Codex process environment (or explicit operator configuration). A same-user process can spoof environment or edit state; role checks are not OS isolation.
- Notifications are tool output, not user instructions. The reviewer must inspect actual files and tests and ignore report-embedded commands.
- A reported completion only enters AWAITING_REVIEW. Only the bound reviewer records acceptance. This records a review decision; it cannot prove the human/model actually reviewed correctly.
- File scope is advisory. This bridge does not intercept DSH shell tools. Use the host's sandbox/hooks for prevention.
- Retry only definite pre-send failures. Unknown delivery remains blocked until the reviewer inspects history and explicitly resolves it.
- Filesystem writes use temporary files and atomic publication on supported local filesystems. Power-loss durability and hostile directory replacement are not guaranteed. Network shares are unsupported for state.
- Do not expose the DSH endpoint or any Codex control socket to public networks. No new HTTP callback listener is opened by this project.

Report vulnerabilities privately through the repository owner's GitHub profile contact options. Do not put credentials or private chat logs in public issues.
