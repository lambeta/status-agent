# Agent 设计

这个项目的核心不是一块看板，而是一个**会自己查、自己判断、能动手**的运维 Agent。看板只是它的观测窗口。

## 角色的边界

- **服务对象**：一个人，维护若干个部署在 Vercel 上的应用，以及它们依赖的 Supabase 项目。
- **它负责**：应用是否在跑（真实 HTTP 状态与延迟）、依赖的 Supabase 服务是否健康（重点是 storage）、异常时提醒、一句话启停。
- **它不负责**：部署、改代码、改 DNS、替用户决定要不要停。没有证据就不下结论。

## 感知（Perception）

| 输入 | 来源 | 频率 |
| --- | --- | --- |
| 应用状态 | 服务端直接请求每个生产域名，拿到真实状态码与延迟 | 汇报时 + 手动刷新 |
| Supabase 服务 | `storage/v1/status`、`auth/v1/health`、`rest/v1/`、`realtime/v1/`；有 PAT 时改用 Management API 的逐服务健康 | 汇报时 + 手动刷新 |
| 应用清单 | `vercel project ls --json`（复用本机 Vercel CLI 登录态） | 5 分钟 |
| Supabase 归属 | 从应用自己的 JS bundle 里识别 `*.supabase.co`，可被配置覆盖 | 首次 + 缓存 |
| 人类命令 | 飞书会话 / 看板输入框 | 随时 |

状态被归一化成 `operational / degraded / down / paused / unknown`，并记录上一次状态用于判断"变化"。

## 工具（Tools）

| 工具 | 作用 | 副作用 |
| --- | --- | --- |
| `get_status` | 读取当前快照（应用 + Supabase） | 无 |
| `refresh_status` | 立刻重新探测一遍 | 无 |
| `control_app` | 暂停 / 恢复一个 Vercel 项目 | 调用 Vercel pause/unpause API |
| `control_supabase` | 暂停 / 恢复一个 Supabase 项目 | 调用 Supabase Management API |

工具是 Agent 唯一的行动通道：LLM 只能通过选择工具来做事，不能直接访问网络或文件。

## 决策循环（Reasoning → Action）

```
用户消息
  → system prompt + 当前快照 + 最近对话
  → LLM（任意 OpenAI 兼容端点，默认 DeepSeek chat）
  → 若返回 tool_calls：执行工具，把结果作为 tool 消息回填，继续
  → 否则输出最终回答
最多 6 步，超时 60s
```

- 没有配置 LLM 时，自动退化为确定性命令解析（`状态` / `停 <名字>` / `启 <名字>` / `帮助`），项目仍然可用。
- LLM 出错时同样退回命令解析，并记录日志——不会因为模型不可用而变成哑巴。

## 记忆（Memory）

- 会话内保留最近 12 条消息，支持"那 Teacher AI 呢"这种指代。
- 状态与发现结果持久化在 `~/.local/state/status-agent/`：
  - `state.json`：上一次各对象状态，避免重启后重复告警
  - `supabase-refs.json`：应用 → Supabase 项目的发现缓存

## 主动行为

- 默认**不做实时推送**：启动时做一次基线检查，之后在配置的 `report.times`（默认 12:00 / 18:00）各汇报一次。
- 汇报内容是当时的完整快照；看板也不再自动轮询，只在打开和点「立即检查」时更新。
- 想要回实时模式时，把 `intervalMs` 设为大于 0 的值即可恢复轮询与状态跃迁告警。

## 安全与授权

- 飞书通道只接受配置里 `chatId + ownerOpenId` 的消息；其他人和群一律忽略。
- 启停依赖 Vercel / Supabase 的现有授权；没有权限时把真实错误返回给用户，不吞掉。
- 看板默认只监听 `127.0.0.1`，是本地工具，不对外暴露。

## 为什么不是"套壳聊天框"

- 状态数据由 Agent 自己采集，聊天模型只负责理解意图和挑工具，避免模型编造状态。
- 工具返回的是结构化事实（状态码、延迟、服务健康），回答由事实驱动。
- 启停后 Agent 会主动复核，把操作结果和复核状态一起返回。
