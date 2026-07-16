# SquadFlow

> A local-first AI agent orchestration desktop app

[中文](README.md) | **English**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#installation)
[![Node](https://img.shields.io/badge/node-22.x-brightgreen.svg)](#running-from-source)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

SquadFlow is a multi-agent collaboration workspace that runs on your computer. A Leader agent coordinates specialist agents through a structured workflow: clarification, architecture, implementation, verification, review, and diagnosis.

Application state, conversations, and project configuration are stored locally in SQLite. When you use a cloud model, requests are sent directly to the OpenAI, Anthropic, or compatible provider you configure. They are not relayed through a server operated by SqualFlow.

## Features

- **Multi-agent orchestration** — The Leader breaks work into tasks and coordinates specialist agents through an approval-ready execution plan.
- **Plan approval and decision cards** — Keep important decisions under human control and provide item-level feedback before execution continues.
- **Two agent runtimes** — Includes an OpenAI Codex runtime and supports the Anthropic Claude Agent SDK, plus compatible custom API endpoints.
- **Local-first storage** — Project files, conversations, and databases remain on your machine; model credentials and requests are handled by the provider you choose.
- **Desktop workflow** — Includes browser preview, element picking, live transcripts, and application updates.

## Installation

Download the latest DMG from [Releases](../../releases). The current build target is Apple Silicon Mac; other platforms are not officially supported yet.

No model provider is created automatically on first launch. Click **Not configured** in the Leader area, then add Codex, Claude, or a compatible endpoint under **Agent Settings → Provider Management**.

## Running from source

Node.js 22 and npm 10 are required:

```bash
npm run setup   # Install each package from its lockfile
npm run dev     # Start the local service, renderer, and Electron shell
```

| Command | Purpose |
| --- | --- |
| `npm run check` | Run type checks, lint, and all tests |
| `npm run build` | Build the production service and renderer |
| `npm run desktop:package` | Build and verify an unsigned local App and DMG |
| `npm run desktop:smoke` | Launch the packaged app with isolated test data |

## Repository layout

```text
apps/
  desktop/       Electron main process, packaging, updates, and bundled runtimes
  local-service/ Local Fastify service, persistence, and agent runtimes
  renderer/      Next.js and React interface
tests/acceptance/ Natural-language desktop acceptance cases
scripts/         Repository-level setup and development orchestration
```

Development data and installed-application data are isolated. The installed app writes mutable data to the system application-data directory named `SquadFlow`, so updating or reinstalling the app does not overwrite it.

On macOS, installed-application data is stored at:

```text
~/Library/Application Support/SquadFlow/
```

Deleting the `.app` does not automatically delete this directory. When using cloud models, you must also follow the terms and data policies of the corresponding model provider.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting. Report security issues privately as described in [SECURITY.md](SECURITY.md), not through a public issue.

## License

The project source code is licensed under the [Apache License 2.0](LICENSE). Third-party components distributed with the application remain subject to their own terms; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). In particular, the Claude Agent SDK is governed by Anthropic's legal terms and is not covered by the project's Apache-2.0 license.
