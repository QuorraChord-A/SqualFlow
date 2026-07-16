# SquadFlow

> 本地优先的 AI 智能体编排工作台 · A local-first AI agent orchestration desktop app

**中文** | [English](README.en.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#安装)
[![Node](https://img.shields.io/badge/node-22.x-brightgreen.svg)](#从源码运行)

SquadFlow 是一个运行在你自己电脑上的多智能体协作工作台：由一个 Leader 智能体带领多位专家智能体，按「澄清 → 架构 → 开发 → 验证 → 评审 → 诊断」的流程协作完成软件任务。

应用状态、会话和项目配置保存在本地 SQLite。使用云模型时，请求会直接发送给你配置的 OpenAI、Anthropic 或兼容服务商，不经过 SqualFlow 运营的中转服务器。

## 功能

- **多智能体编排** — Leader 拆解任务、生成可审批的执行计划，专家智能体并行开发
- **计划审批与决策卡** — 关键节点由你拍板，支持逐条反馈修改计划
- **双运行时** — 内置 OpenAI Codex 运行时，同时支持 Anthropic Claude Agent SDK；也可配置自定义 API 兼容端点
- **本地优先** — 项目文件、会话和数据库保存在本机；模型凭据与网络请求由用户选择的服务商处理
- **桌面级体验** — 内置浏览器预览、元素拾取、实时转录、自动更新

## 安装

从 [Releases](../../releases) 下载最新的 DMG 安装即可。当前构建目标为 Apple Silicon Mac；其他平台尚未正式支持。

首次启动不会自动创建模型供应商。请点击 Leader 区域的「未配置」，进入「智能体设置 → 供应商管理」添加 Codex、Claude 或兼容端点。

## 从源码运行

需要 Node.js 22 与 npm 10：

```bash
npm run setup   # 从锁定文件安装各包依赖
npm run dev     # 启动本地服务、渲染层与 Electron 壳
```

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 类型检查 + lint + 全部测试 |
| `npm run build` | 构建生产版本服务与渲染层 |
| `npm run desktop:package` | 构建未签名的本地 App/DMG 并验证产物 |
| `npm run desktop:smoke` | 用隔离数据启动打包产物做冒烟验证 |

## 目录结构

```text
apps/
  desktop/       Electron 主进程、打包、更新与内置运行时
  local-service/ 本地 Fastify 服务、持久化与智能体运行时
  renderer/      Next.js + React 界面
tests/acceptance/ 自然语言桌面验收用例
scripts/         仓库级安装与开发编排
```

开发数据与已安装应用的数据完全隔离：安装版把可变数据写入系统应用数据目录 `SquadFlow`，升级或重装不会覆盖它。

macOS 安装版数据默认位于：

```text
~/Library/Application Support/SquadFlow/
```

删除 `.app` 不会自动删除该目录。使用云模型时，请同时遵守相应模型服务商的条款与数据政策。

## 安全

安全问题请按 [SECURITY.md](SECURITY.md) 的方式私下报告，不要开公开 issue。

## 许可证

代码以 [Apache License 2.0](LICENSE) 发布。随应用分发的第三方组件适用其各自条款，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；其中 Claude Agent SDK 受 Anthropic 法律条款约束，不在 Apache-2.0 覆盖范围内。
