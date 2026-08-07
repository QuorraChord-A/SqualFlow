# Supervisor 产品契约

## 原则

SquadFlow 提供 Agent 可调用的工具并强制身份、归属、引用、幂等、状态转换、依赖、项目路径、角色能力和权限边界。平台不替 Leader 选择 Expert、改变 Task 状态、暂停协作、取消 Agent 或决定下一步。

## Flow 模式

UI 显示“自动编辑 / 计划模式 / 完全访问”。进入计划模式只修改 `behavior_mode` 并保留 `risk_mode`。计划获批时，仅当 Flow 仍为计划模式才恢复 `execute`；批准不得覆盖用户在等待期间的新选择。

消息、队列项和 AgentRun 不保存模式快照。Leader 实际消费普通消息、自动出队消息或 Guide 时读取 Flow 最新模式。模式切换不会暂停、取消或重排 Run、Task、审批和队列。

## 计划

- 每个 Flow 一个 PlanDocument，正式内容只存在于不可变 PlanRevision。
- 每个修订创建独立 PlanApproval；新版本不继承旧审批。
- 提交待审批计划后结束当前 Leader Run；处理审批后在 Leader Session 可用时创建新 Run。
- 批准只通知 Leader，并按条件退出计划模式；不创建 Task、编排或 Expert。
- 等待审批期间和计划开始后都允许用户要求修改。平台不自动暂停或取消已有工作。

## 编排

- 单 Expert 不要求编排；多 Expert 是 Leader 工作协议要求，后端不使用全局状态机强制打断。
- 编排卡始终显示。创建时固化 `approval_mode_snapshot`。
- `automatic` 不创建审批、没有审批按钮、立即物化 Task，当前 Leader Run 继续。
- `approval_required` 创建 OrchestrationApproval，批准前没有 Task，创建工具结束当前 Leader Run，处理审批后创建新 Leader Run。
- 新修订不自动取消旧 Task 或 Run；旧工作如何处理由 Leader 显式决定。

## Agent 与 Task

- `dispatch_agent` 为 Task 创建新的 Expert AgentSession 和首个 AgentRun。
- `send_message` 对运行中 Session 引导当前 Run；对空闲 Session 创建新 Run并复用 provider 上下文。
- `cancel_agent` 幂等取消指定 Expert Session 的当前活跃 Run。
- 同一 AgentSession 同时最多一个活跃 AgentRun。
- AgentRun 的技术终态不会自动完成、失败或取消 Task。
- ToolCall 权限审批恢复同一 AgentRun；计划、编排和普通澄清解决旧 Run 后创建新 Leader Run。

## ChangeSet

可写 Run 在模型输入前捕获候选 baseline。首次真实写入且未显式选择 ChangeSet 时，懒创建该 Run 的 ChangeSet。写入/编辑按真实路径归属，Shell 通过前后快照归属；并发无法可靠归属的共享文件排除并说明。`finalized` 快照永不被后续修改覆盖。

## UI 必须保留

- 左侧状态优先级：黄色待用户动作 > 绿色活跃 Run > 蓝色未读 > 灰色。
- 未读持久化到用户阅读，不因运行结束清除。
- 输入框圆形停止按钮只取消当前 Leader Run。
- 用户不直接停止单个 Expert；Leader 可调用 `cancel_agent`。
- “中断协作”取消 Flow 全部活跃 Run 和待处理工具权限，但保留 Flow、Task、计划、编排审批和历史。
- 项目/Flow 管理、队列与 Guide、附件、浏览器标注、Transcript、上下文用量和压缩、文件树/预览、工作台、设置、模型、主题和更新入口继续可用。
