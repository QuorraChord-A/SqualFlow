# Agent 测试用例执行手册

生成、更新或执行 `tests/acceptance` 前，先读本文档。

## 目标

把自然语言测试目标转换成 JSON 测试资产：

- Atom：一个可复用的用户意图操作。
- Scenario：按顺序编排 Atom 和内联 Verify。
- Verify：可观察的成功条件。

JSON 只保存意图。禁止保存浏览器 ref 或命令流水。Agent 在执行时自行选择具体命令。

## 工具边界

| 需求 | 工具 |
|------|------|
| 打开、导航、操作、读取浏览器状态 | 优先 `@浏览器` |
| 页面证据 | 优先 `@浏览器` DOM snapshot / screenshot |
| 控制台和网络诊断 | 优先 `@浏览器` Playwright API；必要时用 `playwright-cli console`、`playwright-cli network` |
| 后端/API 状态 | `curl` + JSON 检查 |
| JSON 合法性 | `jq empty` |

执行器优先级：

1. 真实端到端 UI 流程优先用 `@浏览器`。
2. `playwright-cli` 只作为 fallback、批量脚本化执行或 CI 化前的临时工具。
3. Atom / Scenario JSON 只描述意图，不绑定具体执行器。

## 探索优先协议

更新 Atom 或 Scenario 前，必须先探索真实项目。不要凭旧文档、旧 debug 页或记忆改测试资产。

必须同时使用两类信源：

- 代码信源：读取 `apps/renderer/app/page.tsx`、`apps/renderer/app/components/*`、相关 store/hook/API。
- 运行信源：用 `@浏览器` 打开 `http://localhost:3000/`，通过 DOM snapshot 或 screenshot 观察真实可见文案、按钮、弹窗、Tab 和输入框。

探索步骤：

1. 用 `rg` 搜索旧 Atom/Scenario 引用和相关前端组件。
2. 读取真实组件代码，确认入口、状态来源、按钮文案和弹窗字段。
3. 用 `@浏览器` 打开 `http://localhost:3000/`。
4. 获取当前页面 DOM snapshot；视觉布局或样式是验证目标时再补 screenshot。
5. 对需要验证的交互，用当前 snapshot 中的可见文本、角色或稳定定位实际点击一次，再重新获取 snapshot。
6. 将观察结果转写为自然语言 steps/verify。
7. 禁止把运行时 ref、旧 debug 页概念或不存在的按钮写入 JSON。

当前真实产品入口：

- 首页：`http://localhost:3000/`
- 顶部：Workspace 选择器和主题切换。
- 左侧：`Flows` / `Projects` Tab。
- 中间：选中 Flow 后显示聊天区。
- 右侧：选中 Flow 后显示 Run Inspector，Tab 顺序是 `任务` / `阶段` / `专家`。
- WebSocket：页面加载后自动连接；不再有手动 `Connect` 按钮。
- 旧 `/debug/`、事件日志面板、`Data Panel` 展开按钮均不是测试资产目标。

## 选择模式

| 用户请求 | 模式 | 是否改文件 |
|----------|------|------------|
| 生成、新增、设计、同步测试用例 | Authoring | 是 |
| 运行、执行、检查测试用例 | Execution | 否 |
| 修复、更新失败或过期测试用例 | Maintenance | 是，最小改动 |

不确定时：

- 用户要求创建、更新、修复资产：编辑 JSON。
- 用户要求运行、检查结果：只执行，不编辑 JSON。

## 硬规则

必须：

- 新增前搜索现有资产。
- 浏览器动作前获取最新 DOM snapshot。
- 页面变化后重新获取 snapshot。
- 用最新证据 Verify。
- 从真实输出解析 `flowId`、`runId` 等动态值。
- 修改后运行 `jq empty tests/acceptance/atoms/*.json tests/acceptance/scenarios/*/*.json`。
- 汇报通过/失败数量。

禁止：

- 把 `e15` 这类临时 ref 写入 JSON。
- 猜测动态 ID。
- 为一次性断言创建 Atom。
- 把 `@浏览器` / `playwright-cli` 命令流水保存为 Atom steps。
- 重构无关测试资产。

## 资产格式

Atom：

```json
{
  "id": "create-flow",
  "description": "创建一个新的 Flow",
  "params": ["name", "description"],
  "steps": [
    "切换到左侧 Flows Tab",
    "点击 '新建 Flow' 图标或 '+ New Flow' 按钮",
    "在 '新建 SquadFlow' 弹窗的名称输入框填写 '{name}'",
    "在描述输入框填写 '{description}'",
    "点击 '创建' 按钮",
    "最多等待 2 秒，直到 Flows 列表更新"
  ],
  "verify": [
    "Flows 列表中存在名称为 '{name}' 的 Flow",
    "创建后该 Flow 被选中，主区域显示聊天输入框"
  ]
}
```

Scenario：

```json
{
  "name": "WebSocket 连接和基础事件验证",
  "description": "验证真实产品页加载后实时连接可用，并可创建 Flow",
  "category": "smoke",
  "steps": [
    "open-homepage",
    {
      "atom": "create-flow",
      "params": {
        "name": "WS Connection Test",
        "description": "验证真实产品页的实时连接"
      }
    },
    "verify-realtime-ready"
  ]
}
```

Step 形式：

- `"atom-id"`
- `{ "atom": "atom-id", "params": { ... } }`
- `{ "verify": ["自然语言断言", "..."] }`

约束：

- Atom 的 `id` 必须等于文件名去掉 `.json`。
- Atom 的 `params` 列出调用方必须提供的参数。
- Atom 的 `steps` 是自然语言动作，不是固定命令。
- 纯操作 Atom 的 `verify` 可以是 `null`。
- Atom 和内联 Verify 的 `verify` 是自然语言断言数组。
- Atom 禁止调用另一个 Atom。
- Scenario 独有断言才使用内联 Verify。

## Verify

`verify` 使用自然语言断言数组：

```json
{
  "verify": [
    "响应 JSON 中 status 为 '{expectedStatus}' 的 task 数量大于等于 {minCount}",
    "页面中不显示错误提示"
  ]
}
```

执行规则：

- 每条断言都必须验证。
- 页面断言使用最新 DOM snapshot；视觉断言使用最新 screenshot。
- 控制台断言使用最新 console 输出。
- 网络断言使用 network/request 记录。
- API 断言使用 REST 响应 JSON。
- 数组和对象按结构比较。
- 除非明确要求原始文本，否则不要压成一个序列化字符串比较。

## Authoring Mode

用于从自然语言创建或更新测试资产。

步骤：

1. 用 `rg` 搜索 `tests/acceptance/atoms` 和 `tests/acceptance/scenarios`。
2. 能复用现有 Atom 就复用。
3. UI 信息不足时，按“探索优先协议”用代码和 `@浏览器` 探索。
4. 用最新 snapshot 中的可见文本、角色或稳定定位实际走一次交互。
5. 写入最小 Atom/Scenario JSON。
6. 校验 JSON：

```bash
jq empty tests/acceptance/atoms/*.json tests/acceptance/scenarios/*/*.json
```

7. 执行生成或更新后的 Scenario。
8. 汇报结果和变更文件。

仅在以下情况新增 Atom：

- 表示可复用用户意图。
- 可能被多个 Scenario 使用。
- 有稳定可观察结果。

Scenario 独有断言优先使用内联 Verify。

## Execution Mode

用于运行已有 Atom 或 Scenario。

步骤：

1. 加载请求的 JSON。
2. 展开 Scenario steps。
3. 替换 params。
4. Browser Atom：获取 snapshot -> 定位元素 -> 操作 -> 重新获取 snapshot/verify。
5. API Atom：`curl` endpoint -> 检查 JSON -> verify。
6. 从之前真实输出解析动态 params。
7. 默认首个失败即停止，除非用户要求继续。
8. 汇报汇总。

单 Atom 请求格式：

```text
执行 atoms/create-flow.json，参数 name=测试Flow
```

## Maintenance Mode

用于处理过期或失败的测试资产。

步骤：

1. 复现或读取失败证据。
2. 分类原因：
   - UI 交互变化 -> 改 Browser Atom。
   - 业务流程变化 -> 改 Scenario。
   - API 响应变化 -> 改 API Atom。
   - 环境不可用 -> 不改文件，报告阻塞。
3. 只修改受影响文件。
4. 校验 JSON。
5. 执行受影响 Scenario。

## 动态值

当 params 使用 `$context.flowId` 或类似内容：

1. 搜索之前的 snapshot、network 输出、REST 响应或命令输出。
2. 提取唯一值。
3. 写入本次运行上下文。
4. 后续复用。
5. 不唯一则失败。禁止猜测。

示例：

```json
{
  "flowId": "$context.flowId",
  "runId": "$context.runId"
}
```

## 浏览器动作

元素定位优先级：

1. 当前 snapshot 的可见文本/角色。
2. 局部区域上下文，例如 Flows 或 Projects。
3. 通过 `@浏览器` Playwright API 获取的稳定属性。
4. 当前 snapshot ref。

页面变化后禁止使用旧 ref。

执行规则：

- 默认用 `@浏览器` 执行真实页面端到端流程。
- 需要批量脚本化、CLI 复现或 CI 化准备时，才切到 `playwright-cli`。
- 不管使用哪个执行器，都只能把用户意图和可观察断言写入 JSON。
- 不要把执行器内部 ref、selector 调试过程、命令流水写入 JSON。

## 停止条件

遇到以下情况停止并报告失败：

- 目标元素无法唯一定位。
- 动态值无法唯一解析。
- 本地服务或页面不可用。
- REST 响应结构不符合 Atom 预期。
- Verify 使用最新证据后失败。

## 报告格式

```text
Scenario: <name>

✔ open-homepage
✔ create-flow
✗ verify-realtime-ready
  期望：页面底部显示 READY
  证据：最新 snapshot 显示 CONNECTING

通过 2 / 总计 3
```

Authoring/Maintenance 需要附变更文件。
