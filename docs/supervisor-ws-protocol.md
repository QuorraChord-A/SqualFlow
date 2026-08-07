# Supervisor WebSocket 协议

入口为 `/api/ws`。所有客户端消息使用 strict schema，未知字段和已删除字段直接返回 `system:error`。

## 客户端消息

- 订阅：`flow:subscribe`、`flow:unsubscribe`、`session:get`
- 普通输入：`flow:message`、`flow:guide`
- 持久队列：`flow:queue_add`、`flow:queue_edit`、`flow:queue_delete`、`flow:queue_reorder`、`flow:queue_dispatch`、`flow:queue_guide`、`flow:queue_clear`
- 用户动作：`decision_request:resolve|reject|cancel`、`plan:resolve`、`orchestration:resolve`
- 控制：`agent_run:cancel` 只接受当前 Flow 的 Leader Run；`flow:interrupt` 取消全部活跃 Run

消息和队列 payload 不包含任何 Flow 模式。Runtime 消费时从 Flow 读取最新 `behavior_mode`、`risk_mode` 和 `orchestration_mode`。

## 服务端消息

- 投影与确认：`flow:state`、`flow:queue_state`、`flow:message_ack`、`flow:guide_ack`
- 领域事件：`agent_session:event`、`agent_run:event`、`tool_call:event`、`plan:event`、`plan_approval:event`、`orchestration:event`、`orchestration_approval:event`、`task:event`、`change_set:event`、`artifact:event`、`decision_request:event`
- Timeline：`session:transcript_snapshot`、`session:transcript_event`
- Runtime：`context_usage:event`、`context_compaction:event`、`runtime:transport`
- 错误：`system:error`

## 幂等与 revision

- 普通消息和 Guide 使用 `client_message_id`；同 ID 同 payload 重试返回原接收结果，同 ID 不同 payload 冲突。
- 队列编辑使用 `expected_revision`；排序必须精确覆盖当前可编辑队列 ID。
- 计划和编排审批必须携带精确 approval ID 与 `client_action_id`。重复同一动作幂等；过期修订不影响新修订。
- 重复取消终态 Run 不得复活或改写其他 Run。

`flow:state` 是 Supervisor 投影，包含 Flow 模式、Session、Run、ToolCall、Queue、Plan、Orchestration、Task、ChangeSet、Artifact 和 `pending_user_actions`。它不包含旧通用运行对象或兼容 fallback。
