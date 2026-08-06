# WorkRun 与 AgentSession 状态模型重构记录

## 触发问题

- `flow-50201486bd0a`：编排计划卡在状态更新后被重新追加到聊天底部，没有固定在最初的工具消息位置。
- `flow-50201486bd0a`：开发 Expert 修改代码后，聊天内没有稳定显示本次协作的整体 Changed Files / Diff 汇总。
- `flow-331722903a48`：用户要求暂停后 Leader 与 Expert 已停止，但输入框仍显示停止按钮。输入框把 WorkRun、Task、Expert 和 Leader 的状态混成了一个“正在运行”。

## 根因

1. 编排计划被当成独立的全局运行面板，而不是 Canonical Transcript 中一条具有特殊 UI 的 MCP 工具消息。状态更新因此改变了渲染位置。
2. `UserTurn` 同时承担消息轮次、后台工作、执行状态、恢复范围和 Diff 边界，多个生命周期相互覆盖。
3. Leader 使用短期执行 Session 充当长期 transcript channel，新执行会改变历史消息的查询和归属边界。
4. 输入框读取 Flow / WorkRun 的聚合状态，Expert 运行时也会让 Leader 的发送按钮进入停止或排队状态。
5. UI 中断和 Leader MCP 中断原本有两套 Session 收口路径，容易出现 WorkRun 已中断但 Expert AgentSession 仍显示运行的分叉状态。

## 最终模型

- `WorkRun` 是可恢复的后台工作边界，保存 Plan、Task、审批、Artifact、目录、输入快照和 Diff 基线。
- `AgentSession` 是一次真实 Agent 执行。Leader 与 Expert 共用 `queued → streaming → completed | failed | interrupted`。
- `ProviderSession` 是稳定的模型上下文。新 AgentSession 只增加执行审计，不创建新的 Provider 对话。
- Leader transcript 使用稳定的 Flow 级 channel：`leader:<flow_id>`；每条消息单独记录产生它的 `agent_session_id`。
- 输入框只读取当前 Leader AgentSession。Expert 或 WorkRun 继续运行时，Leader 空闲就可以正常发送新消息。
- WorkRun 只有首次派发 Task-backed Expert 后才进入 `executing`；普通聊天与 taskless Expert 对话不创建 WorkRun。
- 中断 WorkRun 保留 Task 状态和 ProviderSession，拒绝后续派发及过期 Task 写入；只有用户明确要求继续时，Leader 才调用恢复工具并重新选择 Expert。

## UI 约束

- 编排计划卡按原工具消息 ID 固定在 transcript 中，状态更新只更新该消息，不追加到底部。
- WorkRun 完成后在对应消息内展示整体 Changed Files / Diff 摘要，并可打开完整 Review。
- 输入框工具栏只增加一个“中断协作”按钮，位于“自动编辑”右侧。
- 按钮只在当前 WorkRun 存在 `queued/streaming` 的 Task-backed Expert AgentSession 时显示；WorkRun 已恢复但尚未重新派发 Expert 时隐藏。
- 停止 Leader 回复只中断 Leader AgentSession，不改变 WorkRun、Task 或 Expert。

## 并发不变量

- 一个 Flow 同时最多一个非终态 WorkRun，包括 `interrupted`。
- WorkRun 中断先校验 revision 并提交状态，再停止所属 AgentSession。
- 派发先提交时，中断必须发现并停止新 Session；中断先提交时，派发返回 `WORK_RUN_INTERRUPTED`。
- Expert 先完成的结果保留；中断后的过期 Task 写入被拒绝。
- 启动恢复只把遗留 `queued/streaming` AgentSession 收口为 `interrupted`，不会自动恢复或重新派发 WorkRun。
