# Third-party notices

SquadFlow is licensed under Apache License 2.0. It also distributes third-party
software under separate licenses or terms. Those separate terms continue to
apply to their respective components.

## Bundled agent runtimes

### OpenAI Codex

- Component: Codex runtime `0.120.0`
- Source: <https://github.com/openai/codex>
- Pinned commit: `65319eb1400cbd2890c43d572263dabd25f18ba9`
- License: Apache License 2.0
- Modification: `apps/desktop/resources/codex-runtime/patches/0001-tolerate-missing-cached-tokens.patch`

The upstream attribution text is preserved in the repository `NOTICE` file.

### Anthropic Claude Agent SDK

- Components: `@anthropic-ai/claude-agent-sdk` and its platform-native CLI
- Version: `0.3.167`
- Source: <https://github.com/anthropics/claude-agent-sdk-typescript>
- Terms: <https://code.claude.com/docs/en/legal-and-compliance>

These components are not covered by SquadFlow's Apache-2.0 license. Their
package license states that use is subject to Anthropic's legal agreements.
The original `LICENSE.md` files remain inside the packaged application.
Before a public binary release, the maintainer must confirm that the intended
distribution and authentication model comply with the then-current Anthropic
terms.

## Desktop and JavaScript dependencies

The desktop application uses Electron `42.5.0` under the MIT license. Direct
production dependencies are listed below; their transitive dependencies retain
their own licenses and copyright notices in the installed npm packages and the
packaged application.

| License | Direct production dependencies |
| --- | --- |
| Apache-2.0 | `@streamdown/cjk`, `@streamdown/code`, `@streamdown/mermaid`, `ai`, `class-variance-authority`, `drizzle-orm`, `streamdown` |
| ISC | `lucide-react` |
| MIT | `@base-ui/react`, CodeMirror and Lezer packages, Iconify React and Devicon packages, Radix UI packages, `@rive-app/react-webgl2`, `@tailwindcss/postcss`, `@xyflow/react`, `@fastify/websocket`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `electron`, `electron-log`, `electron-updater`, `fastify`, `next`, `react`, `react-dom`, `shiki`, `zod`, and the remaining renderer UI utilities declared in `apps/renderer/package.json` |
| Anthropic legal agreements | `@anthropic-ai/claude-agent-sdk` and its platform-native CLI |

The package lock files are the authoritative version inventory. Dependency
updates must include a review of changed licenses and notices before release.
Packaged Apps also contain `legal/runtime/runtime-packages.json` and the
license files found in each shipped runtime package.

### sharp and libvips

The Next.js standalone runtime currently includes sharp `0.34.5` and the
`@img/sharp-libvips-darwin-*` `1.2.4` binary packages. The prebuilt libvips
bundle contains libraries under several permissive, MPL, and LGPL licenses.
The pinned upstream notice is distributed as
`legal/sharp-libvips-1.2.4-THIRD-PARTY-NOTICES.md`; the LGPLv3 and GPLv3 texts
are distributed alongside it.

### npm packages without embedded license files

Some published npm archives declare a license in `package.json` but omit a
standalone license file. The MIT text and copyright holders for
`standardwebhooks`, `lazy-val`, and `abstract-logging` are preserved in
`legal/npm-runtime-MIT.txt`. `@next/env` is covered by the copied Next.js MIT
license, `client-only` by the copied React MIT license, and `drizzle-orm` by the
Apache-2.0 text distributed with SquadFlow.
