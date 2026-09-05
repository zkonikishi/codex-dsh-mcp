# 网页任务通道 / Web task channel

`web_task` 已实现持久化任务记录；网页操作由调用方的受支持浏览器工具执行。
它不是在后台自行控制 ChatGPT 的服务，也不借用或导出登录凭据。

State: PREPARED → BOUND → SUBMISSION_UNKNOWN → AWAITING_REVIEW → ACCEPTED.
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
- Live browser attempt: tab inventory works, but ChatGPT page acquisition timed
  out in both in-app browser and Edge. No prompt was submitted.
- Live text roundtrip, image/video generation, artifact downloads and automatic
  return-to-reviewer remain unverified. Do not advertise them as complete.
