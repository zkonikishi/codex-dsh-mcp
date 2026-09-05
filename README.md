# Codex DSH MCP

Codex 规划与独立审核，DeepSeek Harness 实施。本地 stdio MCP，无需 Docker，不抢浏览器标签页。非 OpenAI / DeepSeek 官方项目。

## 状态 / Status

**0.2.0 开发版，尚未完成真实双端验收。**

已实现并有本地测试：会话读取/派单适配、重复请求保护、原 Codex 审核者绑定、每轮完成票据、持久待审核队列、Codex app-server 通知适配、有限重试、审核通过/退回、轮次上限、归档与恢复。完成报告不等于通过审核。

本机真实检查仍有两项连接阻塞：DSH Web 返回 AUTH_REQUIRED；Codex 共享 app-server proxy 不可连接。**因此不能宣称本机已能自动唤醒桌面任务。** 不读取浏览器凭据、不修改会话数据库、不启动另一台同名服务绕过。

Development implementation; authenticated live DSH dispatch and notification to the intended Codex runtime remain unverified. No stable Release published.

## 使用 / Usage

新增独立[网页任务通道](docs/WEB_CHANNEL.md)：`web_task` 保存任务、标签页绑定、提交前防重记录和待审核结果，支持最多三轮同聊天修改与已审核结果导出。OOChat 只读案例已实测文字往返、修改、网页出图及 PNG 保存；实际操作由 Codex 浏览器工具完成，不是无人值守浏览器服务。视频和自动桌面唤醒尚未验收。

See [setup and recovery](docs/OPERATIONS.md), [configuration example](examples/config.example.json), [security](SECURITY.md), and the optional [companion skill](skills/codex-dsh-workflow/SKILL.md).

Requires Node 22+, PowerShell 7.2+, the supported Windows DSH Web launch layout, and a reachable Codex app-server proxy for automatic notifications. Paths, port and allowed projects are configurable. Keep DSH_MCP_CONFIG, authentication and state outside this repository.

```text
Codex -> workflow_dispatch -> DSH implementation
                             -> signed completion report
       <- app-server tool output <- persistent worker
Codex -> independent review -> accept / bounded rework
```

| Tool | Purpose |
| --- | --- |
| dsh_status / codex_status | Live connection diagnosis; no model task created |
| dsh_sessions / dsh_history / dsh_wait | Bounded observation; idle is not success |
| dsh_prompt | Existing-session submission with deduplication |
| workflow_dispatch | Bound dispatch with a completion ticket |
| workflow_status | Original reviewer's tasks and delivery states |
| workflow_review | Independent acceptance or bounded rework |
| workflow_resolve_notification | Resolve uncertain notification after inspecting history |
| workflow_archive | Archive accepted records; no project deletion |
| review_bind / review_complete / review_pending | Legacy local unverified inbox, no automatic notification |

With autoRunner enabled, dispatch requests a detached completion scanner. Or run `node runner.mjs` manually. Restart the runner after machine restart; no global startup service is installed. Credentials never go in prompts. Tickets are private files. Same-user filesystem access is trusted, not a hostile-process security boundary.

## Testing

```sh
npm test
node doctor.mjs
```

Set TEMP/TMP to a writable temporary directory. Tests cover local protocol, receipts, duplicate writes, stale rounds, rework, notification uncertainty and role binding. They are not live DSH/Codex acceptance.

## References

[Workflow design](docs/WORKFLOW_DESIGN.md) separates transport, orchestration and optional specialist profiles. Scope prompts are not hooks or a sandbox. Referenced projects were not installed and their code was not imported.

PowerShell bridge provenance: adapted from locally installed dsh-delegator scripts; originals unchanged. Redistribution license selection remains pending; public visibility is not a license grant.
