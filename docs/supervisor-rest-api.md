# Supervisor REST API

REST 负责初始化、CRUD、设置、工作台和只读查询；实时消息、队列、审批、停止和中断使用 WebSocket。

## 主要资源

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET/POST | `/api/projects`、`/api/projects/new` | 查询、注册或新建 Project |
| GET/POST/PUT/DELETE | `/api/flows`、`/api/flows/:flowId` | Flow CRUD；字段使用三个独立模式 |
| POST | `/api/flows/:flowId/read` | 只清除该 Flow 未读 |
| POST | `/api/flows/:flowId/context/compact` | Leader Session 空闲时压缩上下文 |
| GET | `/api/agent-definitions` | 查询角色与工具定义 |
| GET | `/api/flows/:flowId/agent-sessions` | Session 身份与 active/latest Run 投影 |
| GET | `/api/flows/:flowId/agent-runs` | Run 技术历史 |
| GET | `/api/flows/:flowId/plan`、`/plan-revisions` | 当前计划与不可变修订 |
| GET | `/api/flows/:flowId/orchestration-plans` | 编排历史 |
| GET/PUT | `/api/flows/:flowId/orchestration-settings` | Flow 编排审批模式 |
| GET | `/api/flows/:flowId/tasks` | Task 与依赖投影 |
| GET | `/api/flows/:flowId/change-sets` | ChangeSet、贡献与冻结 Diff |
| POST | `/api/flows/:flowId/change-sets/:id/finalize` | 冻结历史快照 |
| POST | `/api/flows/:flowId/change-sets/:id/abandon` | 放弃 open ChangeSet |
| GET | `/api/flows/:flowId/workbench` | Team、Session、Run、Task、Artifact、ChangeSet 投影 |
| GET/DELETE | `/api/flows/:flowId/files` | 项目根内文件树和删除 |
| GET | `/api/flows/:flowId/file-preview` | 只读 UTF-8 文本预览，限制 1 MiB |

Flow 请求和响应不接受旧运行模型字段。`behavior_mode`、`risk_mode`、`orchestration_mode` 可独立更新；未提供字段保持不变。运行中的 Leader Session 不允许跨 SDK 切换。

错误使用稳定 HTTP 状态：400 非法字段/路径，404 不存在或归属不匹配，409 活跃 Session、revision 冲突或非法状态，413 预览超限，415 非 UTF-8 文本。
