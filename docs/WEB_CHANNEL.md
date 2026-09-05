# 网页任务通道 / Web task channel

`web_task` 已实现持久化任务记录；网页操作由调用方的受支持浏览器工具执行。
它不是在后台自行控制 ChatGPT 的服务，也不借用或导出登录凭据。

State: PREPARED → BOUND → SUBMISSION_UNKNOWN → AWAITING_REVIEW → ACCEPTED.
`revise` returns an observed result to BOUND in the SAME conversation with a fresh
marker, preserving history, up to 3 rounds. `export` writes the accepted result
as private JSON under the state directory and returns a SHA-256.
Claim is persisted before Send, with revision CAS, task marker, exact conversation
binding and a tab reservation. Uncertain delivery is never automatically retried.
Results are agent-reported observations, not signed server receipts.

Supported ledger kinds: text/image/video. These labels DO NOT establish that a
ChatGPT account can generate media. Verify the actual UI before dispatch.
Sensitive uploads require explicit destination/data authorization.

Use [the browser workflow skill](../skills/chatgpt-web-task/SKILL.md).
The module is exposed via MCP `web_task`; existing processes must reload to see
the added tool. There is no private browser API, extension, headless driver or
standalone unattended browser executor in this slice.

## 当前验收 / Evidence

- Local unit tests cover persistence, ownership, revision, duplicate claim,
  URL validation, same-chat result binding and task markers.
- 2026-09-05 OOChat read-only test: a marked text prompt was submitted once in a
  dedicated ChatGPT conversation; response read and independently checked. A
  second marked revision in the SAME chat produced the expected shortened text.
- In the same test, the visible Create Image tool generated a black-cat/bubble
  concept image. It was visually inspected and exported using supported browser
  pageAssets. Actual PNG: 1254x1254, 1,541,556 bytes; file integrity checked locally.
  No private source was uploaded or existing product branding replaced.
- In-app observations took around 43-65 seconds. Short outer tool timeouts were
  insufficient; after timeout inspect the page first, NEVER repeat Send blindly.
  Do not treat longer timeouts as proof that every browser fault is solved.
- Video: no generation entry visible in the tested menu; not validated.
- Agent-operated text/rework/image roundtrip passed. This is NOT a standalone
  browser worker, automatic desktop wakeup, or whole-OOChat product acceptance.
