# Supervisor 架构评审结论

## 已锁定决定

1. 用多个窄职责领域对象替代万能运行状态机，不创建通用替代物。
2. Flow 模式、消息队列和 Guide 三者正交；平台不因切换模式产生控制副作用。
3. Leader 拥有协作自主权。平台通过工具和数据边界限制越权，不强制替 Leader 选择执行策略。
4. AgentSession 表达长期身份，AgentRun 表达一次执行，AgentRuntime 表达运行服务；三者不可互换。
5. ToolCall 是产品术语，Function Call 仅是 SDK 实现细节。
6. Plan 和 Orchestration 分离；各自使用精确审批，不引入通用 Approval 状态机。
7. Task 是业务事实，AgentRun 是技术事实，两者不相互推导。
8. ChangeSet 只承担 Diff 与 Review，不能拥有消息、计划、Task 或协作控制状态。
9. Canonical Timeline 保持聊天唯一事实源；结构化对象通过稳定引用投影。
10. clean break 不兼容旧 Flow 数据和旧协议；升级只保留 Project、全局设置、Runtime 配置与用户工程文件。

## 被拒绝的耦合

- 给消息或队列项保存 Plan 模式快照。
- 切换 Plan 自动暂停、取消或重新派发 Run。
- 编排审批设置追溯修改已创建卡片。
- AgentRun 成功自动完成 Task。
- 新编排修订自动取消旧 Task/Run。
- 平台自动挑选 Expert 或决定复用/重新派发。
- 用一个 pending-action/approval 表承载所有审批生命周期。
- 用 ChangeSet 重新承载已删除的通用执行生命周期。

## 验证门槛

自动化必须覆盖领域转换、幂等、数据库升级、Runtime adapter、REST/WS/MCP、Queue/Timeline、Renderer 和 ChangeSet；中文验收资产必须通过 `npm run acceptance:validate`。交付前还必须通过 `npm run check`、`git diff --check`、未签名桌面打包、desktop smoke 和打包 App 的 Luna 用户视角回归。
