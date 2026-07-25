<p align="center">
  <img src="apps/desktop/assets/icon-source.png" width="128" alt="SquadFlow 应用图标">
</p>

<h1 align="center">SquadFlow</h1>

<p align="center">本地优先的 AI 智能体编排工作台</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 License"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS"></a>
  <a href="#从源码运行"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22"></a>
</p>

SquadFlow 是一个运行在本机的多智能体协作工作台。你提出目标，Leader 负责澄清需求和组织计划，专家智能体分别承担架构、开发、验证、评审与诊断等工作；关键决策仍由你确认。

## 它如何工作

1. **创建 Flow** — 选择项目目录并描述要完成的目标。
2. **确认计划** — Leader 拆解任务、安排专家，并把执行计划交给你审批。
3. **协作执行** — 专家智能体在同一 Flow 中并行推进，过程和结果持续回传。
4. **验收与调整** — 通过决策卡、反馈和后续消息修正方向，直到任务完成。

## 核心能力

- **Leader 与专家协作** — 将复杂目标拆成职责清晰、可追踪的智能体任务。
- **计划审批与人工决策** — 执行前审阅计划，在关键节点逐项确认或反馈。
- **多运行时支持** — 使用 Codex、Claude，或连接兼容的自定义模型端点。
- **一体化工作台** — 在桌面应用内查看文件、运行过程、浏览器预览和网页元素。
- **可恢复的 Flow** — 会话、任务状态和执行记录可在应用重启后继续查看。
- **桌面更新** — 在应用内检查、下载、暂停、恢复并安装新版本。

## 数据与隐私

工作区信息、会话记录和应用设置默认保存在你的电脑上。

连接云模型时，请求会直接发送给你配置的模型服务商；SquadFlow 不运营模型请求中转服务。发送给模型的数据仍受对应服务商的条款和数据政策约束。

## 安装

从 [Releases](../../releases) 下载最新的 DMG，将 SquadFlow 拖入“应用程序”即可。当前正式构建面向 Apple Silicon Mac，其他平台尚未正式支持。

## 首次配置

首次启动不会自动创建模型供应商。点击 Leader 区域的“未配置”，然后在“智能体设置 → 供应商管理”中添加 Codex、Claude 或兼容端点。

## 技术架构

本节面向希望了解或参与开发的读者：

- **桌面壳** — Electron
- **界面** — Next.js + React
- **本地服务** — TypeScript + Fastify
- **本地持久化** — SQLite
- **智能体运行时** — 内置 Codex，并支持 Claude Agent SDK

安装版的可变数据位于：

```text
~/Library/Application Support/SquadFlow/
```

更新或替换 `.app` 不会覆盖该目录；删除 `.app` 也不会自动删除其中的数据。

## 从源码运行

需要 Node.js 22 与 npm 10：

```bash
npm run setup   # 从锁定文件安装各包依赖
npm run dev     # 启动本地服务、渲染层与 Electron 壳
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 类型检查、lint 和全部测试 |
| `npm run build` | 构建生产版本服务与渲染层 |
| `npm run desktop:package` | 构建并验证未签名的本地 App 与 DMG |
| `npm run desktop:smoke` | 使用隔离数据启动打包产物并执行冒烟验证 |

源码开发数据与已安装应用数据相互隔离。开发态数据统一写入仓库中被 Git 忽略的 `output/` 目录。

## 仓库结构

```text
apps/
  desktop/       Electron 主进程、打包、更新与内置运行时
  local-service/ 本地 Fastify 服务、持久化与智能体运行时
  renderer/      Next.js + React 界面
tests/acceptance/ 自然语言桌面验收用例
scripts/         仓库级安装与开发编排
```

提交改动前请运行 `npm run check`。涉及桌面壳、启动流程或打包的改动还应运行桌面打包与冒烟验证。

## 安全

安全问题请按 [SECURITY.md](SECURITY.md) 的方式私下报告，不要创建公开 issue。

## 许可证

代码以 [Apache License 2.0](LICENSE) 发布。随应用分发的第三方组件适用其各自条款，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
