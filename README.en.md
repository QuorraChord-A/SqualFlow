<p align="center">
  <img src="apps/desktop/assets/icon-source.png" width="128" alt="SquadFlow app icon">
</p>

<h1 align="center">SquadFlow</h1>

<p align="center">A local-first AI agent orchestration workspace</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 License"></a>
  <a href="#installation"><img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS"></a>
  <a href="#running-from-source"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22"></a>
</p>

SquadFlow is a multi-agent collaboration workspace that runs on your computer. You describe a goal, choose a project directory and model, and the Leader clarifies, plans, and coordinates the work. Specialist agents handle implementation, verification, review, and diagnosis while plans, key decisions, and execution stay visible to you.

## Why SquadFlow

- **Organize complex work into Flows** — A Flow keeps the goal, conversation, plan, tasks, tool calls, and result together and remains available after restart.
- **Leader and specialist collaboration** — The Leader turns a goal into traceable work and delegates to specialists instead of forcing everything into one chat turn.
- **Human control throughout** — Review requirement and orchestration plans, respond to the matching user-action card, and redirect work when it matters.
- **Choose your runtime** — Use Codex, Claude, or a compatible custom model endpoint. Configure models and credentials through the in-app provider manager.
- **Use native project context** — Discover available Skills and MCP servers from the current project and your machine; type `/` to filter and select them.
- **See what tools did** — The workbench shows the exact MCP server and tool, status, input, and result. When an MCP provides an icon, it is shown in the active Flow.
- **Local-first** — Conversations, project associations, and app settings remain on your computer by default. SquadFlow does not operate a model-request relay.

## How to use it

1. **Create a Flow** — Choose a project directory, describe the outcome, and select a model.
2. **Add context** — Type `/` in the composer, filter available Skills and MCP servers by name or description, then use the arrow keys and Enter to insert a selection.
3. **Review plans** — The Leader explains the requirement plan and multi-expert orchestration; confirm, reject, or add constraints through the matching card.
4. **Follow execution** — Inspect specialist progress, file operations, browser activity, and MCP results. Expand tool groups for raw details.
5. **Continue the collaboration** — Follow up, correct course, or add work in the same Flow. Its state and conversation are persisted.

## Skills and MCP

SquadFlow reuses the native context available to the current Flow instead of requiring a separate, manually maintained list for each conversation.

- **Skills** — Project-scoped Skills take precedence over global Skills. A chosen Skill is shown as an inline entity in the composer and transcript.
- **MCP** — The app shows MCP tools that the current runtime connected successfully. Results render the standard MCP content structure for text, images, resource links, and structured data; a default MCP icon is used when the server supplies none.
- **Scope** — A new Flow shows globally available items. A Flow attached to a project shows both project and global items, prioritizing items nearest to that project.
- **Security boundary** — MCP servers may start local processes, read or write files, or call external services. Enable only machine and project configuration you trust, and understand its permissions and side effects before use.

Selections are stored as standard Markdown links. The same user message can therefore move consistently between the composer, transcript, and runtime, while the interface simply renders recognized Skill and MCP links as readable inline entities.

## Data and privacy

Workspace information, conversations, and application settings are stored on your computer by default. When you connect a cloud model, requests are sent directly to the provider you configure; data sent to that provider remains subject to its terms and data policies.

Mutable data for the installed app is stored at:

```text
~/Library/Application Support/SquadFlow/
```

Updating or replacing the `.app` does not overwrite this directory, and deleting the `.app` does not remove it automatically. Source-development data and installed-app data are isolated; development data is written to the ignored root `output/` directory.

## Installation

Download the latest DMG from [Releases](../../releases), then drag SquadFlow into Applications. The current production build targets Apple Silicon Macs; other platforms are not officially supported yet.

### First-time setup

No model provider is created automatically on first launch. Click **Not configured** in the Leader area, then add Codex, Claude, or a compatible endpoint under **Agent Settings → Provider Management**. After creating or opening a Flow, choose the model that Flow should use.

## Technical architecture

| Layer | Technology and responsibility |
| --- | --- |
| Desktop shell | Electron: windows, system integration, updates, packaging, and bundled runtimes |
| Interface | Next.js + React: Flows, chat, plan/orchestration cards, tools, and browser workbench |
| Local service | TypeScript + Fastify: persistence, protocol, permissions, and agent orchestration |
| Data | SQLite: local Flows, messages, tasks, and settings |
| Agent runtimes | Codex App Server, Claude Agent SDK, and compatible custom model endpoints |

## Running from source

Node.js 22 and npm 10 are required:

```bash
npm run setup   # Install each package from its lockfile
npm run dev     # Start the local service, renderer, and Electron shell
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm run check` | Run type checks, lint, and all tests |
| `npm run build` | Build the production service and renderer |
| `npm run desktop:package` | Build and verify an unsigned local App, DMG, and update ZIP |
| `npm run desktop:smoke` | Launch the packaged app with isolated data for smoke testing |

## Repository layout

```text
apps/
  desktop/       Electron main process, packaging, updates, and bundled runtimes
  local-service/ Local Fastify service, persistence, and agent runtimes
  renderer/      Next.js and React interface
tests/acceptance/ Natural-language desktop acceptance cases
scripts/         Repository-level setup and development orchestration
```

See the [Supervisor terminology](docs/supervisor-terminology.md), [product contract](docs/supervisor-product-contract.md), [system design](docs/supervisor-architecture.md), [REST API](docs/supervisor-rest-api.md), and [WebSocket protocol](docs/supervisor-ws-protocol.md) for the clean-break architecture.

Run `npm run check` before submitting changes. Changes to the desktop shell, startup flow, or packaging should also run the desktop package and smoke checks.

## Security

Report security issues privately as described in [SECURITY.md](SECURITY.md), not through a public issue.

## License

The project source code is licensed under the [Apache License 2.0](LICENSE). Third-party components distributed with the application remain subject to their own terms; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
