# Codex DSH MCP

Codex 与 DeepSeek Harness Web 的本地 MCP 桥接原型。当前为 **0.1.0 开发原型，非正式稳定版**，不属于 OpenAI 或 DeepSeek 官方项目。

## 当前状态 / Status

- 已实现：stdio MCP、Web 进程身份检查、会话列表/历史/派单/等待适配、同会话写锁、requestId 去重与不确定投递保护。
- 已验证：6 项本地测试、MCP 握手；真实 Web 返回 401，认证错误被正确识别。
- 待验收：真实已认证会话读取、实际派单与完成结果读取。不能把本地测试视为端到端通过。
- 计划中：DSH 完成后自动通知原 Codex 任务、唤醒独立审核、审核退回和持久重试。**当前版本尚未实现此闭环。**
- 当前进程发现适配器针对维护者的 Windows 安装布局；其他安装需修改路径，暂不是通用一键安装包。

Public source visibility does not establish end-to-end acceptance. Automatic completion notifications to Codex are planned, not available in this revision.

Local stdio MCP for the existing DSH Web installation. No HTTP listener, Docker, browser-tab ownership or DSH restart required.

Tools: `dsh_status`, `dsh_sessions`, `dsh_history`, `dsh_prompt`, `dsh_wait`.

Configuration: `D:/Servers/AI/Data/Codex/integrations/codex-dsh-mcp/config.json`. Auth is optional for discovery but required by the live DSH service. Supply an explicitly authorized file containing `baseUrl` and exactly one of `launchToken` or `cookie`, using the existing bridge format. The bridge never discovers credentials or reads browser databases/signing secrets. Configure `authFile` only after that file exists. Do not paste credentials in task prompts or commit them.

The configured Web process is verified by executable, exact CLI arguments, listener PID and start time on requests. This installation uses loopback port 3080. Changed installation paths require an explicit adapter update.

Submit only to an existing session after checking its project. Running sessions are rejected. A cross-process session lock and durable request fingerprint prevent duplicate local writes; unknown delivery remains unknown until history is inspected. Never delete locks or receipts to retry uncertain writes. A stalled/crashed MCP may leave a lock requiring inspection. The lock does not control tasks submitted through other clients.

History is a bounded initial snapshot, not a full export. Waiting observes idle, not success. The project owner must review actual changes and independently verify them.

Run `node --test test/*.test.mjs` for local protocol/deduplication tests. These do not prove live authentication. Run through MCP `dsh_status`, then `dsh_sessions`, then `dsh_history` before enabling task delegation.

No session creation, arbitrary RPC forwarding, settings/model mutation, service restart or automatic cancellation tool is exposed in v0.1.0.

Bridge adaptation provenance: copied from the locally installed dsh-delegator scripts and adapted for this explicitly configured Node Web host; original skill files remain unchanged.
