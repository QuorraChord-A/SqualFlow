# Supervisor 术语表

本文件是 SquadFlow 当前产品与代码沟通的主术语。旧 Flow 运行数据和旧协议不兼容、不迁移。

| 术语 | 定义 |
| --- | --- |
| Project | 本地工程目录，也是文件与命令的硬边界。 |
| Flow | 长期协作空间；保存模式和结构化业务对象，但不保存全局运行状态机。 |
| AgentDefinition | 角色、提示词、内置工具、MCP 工具和只读/可写能力定义。 |
| AgentSession | Flow 内可持续复用的 Agent 身份和 provider 会话归属。一个 Flow 只有一个 Leader Session。 |
| AgentRun | AgentSession 的一次实际执行，状态为 `queued | running | waiting_tool_approval | completed | failed | cancelled | interrupted`。 |
| AgentRuntime | 组装 ModelInput、执行 AgentRun、转译 SDK 事件和调用工具的运行层。 |
| ToolCall | 一次工具调用的产品记录。Function Call 只是底层实现类型。 |
| ModelInput | 非持久化、无 ID 的模型输入值。 |
| ToolContext | 非持久化、无 ID 的工具调用上下文。 |
| PlanDocument | 每个 Flow 唯一的需求计划文档。 |
| PlanRevision | PlanDocument 的不可变正式修订。 |
| PlanApproval | 精确绑定一个 PlanRevision 的用户审批。 |
| OrchestrationPlan | 与 PlanDocument 分离的执行编排文档。 |
| OrchestrationRevision | 不可变编排版本，包含创建时固化的审批模式。 |
| OrchestrationNode | 推荐 AgentDefinition、工作内容、验收和依赖；不是 AgentSession。 |
| OrchestrationApproval | 只为 `approval_required` 编排版本创建的精确审批。 |
| Task | 持久业务工作单元；保存目标、说明、验收、依赖、进度、结果和显式业务状态。 |
| DecisionRequest | 普通澄清或工具权限请求；与计划/编排审批分离。 |
| ChangeSet | 只负责 baseline、真实触达文件、Diff、贡献关系和 Review 的窄职责对象。 |
| Artifact | Flow 内结构化产物；必须引用来源 AgentRun，可选引用 Task 和 ChangeSet。 |
| Canonical Timeline | 用户可见聊天的唯一持久事实源。结构化卡片通过引用投影到 Timeline。 |
| QueuedMessage | 后端持久化的待消费普通消息；不保存模式快照。 |
| Guide | 用户把消息送给当前 Leader Run 的即时引导；不等于 Plan，也不改变 Flow 模式。 |

Flow 有三个正交设置：

- `behavior_mode: execute | plan`
- `risk_mode: auto_edit | full_access`
- `orchestration_mode: approval_required | automatic`

明确删除且不得作为兼容别名重新出现的产品模型：旧的通用工作运行实体、Flow 专家槽位实体、Spec 系列实体、计划执行实例和万能审批/状态机。
