# Supervisor 中文黑盒验收资产

本目录是打包后 SquadFlow 的用户视角验收契约。资产只描述用户意图和可观察结果，不保存选择器、元素索引、数据库语句、REST 调试命令或浏览器临时引用。

## 资产

- `atoms/*.json`：可复用的最小用户操作。
- `verifies/*.json`：可复用的用户可见断言集合。
- `scenarios/*.json`：完整场景，包含前置条件、真实中文需求、操作、断言、恢复和清理。
- `schema.json`：三类资产的结构约束。

运行 `npm run acceptance:validate` 会先用 `jq empty` 校验全部 JSON，再检查文件名、引用、必填字段、中文需求和禁用的实现细节。

## 黑盒执行规则

1. 只操作本地打包后的 App，使用隔离的 userData 和专用测试工程。
2. 每次界面状态改变后重新读取无障碍树；视觉布局、颜色和动画需要截图确认。
3. 场景中的 `requirement` 必须作为真实中文 prompt 发送，不得替换成测试指令或调试 payload。
4. 日志、REST、数据库只用于失败后的只读诊断，不能替代 UI 路径。
5. 一个场景失败后继续执行其余场景，并逐项记录 `PASS | FAIL | BLOCKED`。
6. 外部模型、凭据或 macOS 自动化权限缺失时标记 `BLOCKED`，不得降级为通过。
7. 证据写入被 Git 忽略的 `output/evidence/supervisor-refactor-e2e/<timestamp>/`。

## Supervisor 验收不变量

- Flow 模式与队列/Guide 独立；Leader 消费时读取 Flow 最新模式。
- Plan 与 Orchestration 是两类卡片和两类审批，不共用状态机。
- 自动编排有卡片但没有审批按钮；需要批准的编排在批准前没有 Task。
- AgentRun 技术终态不自动改变 Task 业务状态。
- 停止按钮只停 Leader 当前 Run；中断协作停止 Flow 全部活跃 Run。
- 左侧状态优先级为黄（待用户动作）> 绿（活跃 Run）> 蓝（未读）> 灰。
- ChangeSet 是可冻结的 Diff 历史，不拥有协作运行状态。
