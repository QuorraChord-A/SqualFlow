<p align="center">
  <img src="apps/desktop/assets/icon-source.png" width="128" alt="SquadFlow app icon">
</p>

<h1 align="center">SquadFlow</h1>

<p align="center">A local-first AI agent orchestration desktop app</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 License"></a>
  <a href="#installation"><img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS"></a>
  <a href="#running-from-source"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22"></a>
</p>

SquadFlow is a multi-agent collaboration workspace that runs on your computer. You describe a goal, the Leader clarifies the request and organizes a plan, and specialist agents take on architecture, implementation, verification, review, and diagnosis while you retain control of important decisions.

## How it works

1. **Create a Flow** — Choose a project directory and describe the outcome you want.
2. **Approve the plan** — The Leader breaks down the work, assigns specialists, and asks you to review the execution plan.
3. **Run the collaboration** — Specialist agents work within the same Flow and continuously report progress and results.
4. **Review and adjust** — Use decision cards, feedback, and follow-up messages to refine the direction until the work is complete.

## Core capabilities

- **Leader and specialist collaboration** — Turn complex goals into clearly owned, traceable agent tasks.
- **Plan approval and human decisions** — Review plans before execution and respond at important checkpoints.
- **Multiple runtimes** — Use Codex, Claude, or a compatible custom model endpoint.
- **Integrated workbench** — Inspect files, runtime activity, browser previews, and web elements inside the desktop app.
- **Recoverable Flows** — Return to conversations, task state, and execution records after restarting the app.
- **Desktop updates** — Check, download, pause, resume, and install new releases from the app.

## Data and privacy

Workspace information, conversations, and application settings are stored on your computer by default.

When you connect a cloud model, requests are sent directly to the model provider you configure; SquadFlow does not operate a model-request relay. Data sent to a provider remains subject to that provider's terms and data policies.

## Installation

Download the latest DMG from [Releases](../../releases), then drag SquadFlow into Applications. The current production build targets Apple Silicon Mac; other platforms are not officially supported yet.

## First-time setup

No model provider is created automatically on first launch. Click **Not configured** in the Leader area, then add Codex, Claude, or a compatible endpoint under **Agent Settings → Provider Management**.

## Technical architecture

This section is for readers who want to understand or contribute to the implementation:

- **Desktop shell** — Electron
- **Interface** — Next.js + React
- **Local service** — TypeScript + Fastify
- **Local persistence** — SQLite
- **Agent runtimes** — Bundled Codex with Claude Agent SDK support

Mutable data for the installed app is stored at:

```text
~/Library/Application Support/SquadFlow/
```

Updating or replacing the `.app` does not overwrite this directory, and deleting the `.app` does not remove it automatically.

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
| `npm run desktop:package` | Build and verify an unsigned local App and DMG |
| `npm run desktop:smoke` | Launch the packaged app with isolated data for smoke testing |

Development data and installed-application data are isolated. Source development writes application-owned mutable data to the ignored root `output/` directory.

## Repository layout

```text
apps/
  desktop/       Electron main process, packaging, updates, and bundled runtimes
  local-service/ Local Fastify service, persistence, and agent runtimes
  renderer/      Next.js and React interface
tests/acceptance/ Natural-language desktop acceptance cases
scripts/         Repository-level setup and development orchestration
```

Run `npm run check` before submitting changes. Changes to the desktop shell, startup flow, or packaging should also run the desktop package and smoke checks.

## Security

Report security issues privately as described in [SECURITY.md](SECURITY.md), not through a public issue.

## License

The project source code is licensed under the [Apache License 2.0](LICENSE). Third-party components distributed with the application remain subject to their own terms; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
