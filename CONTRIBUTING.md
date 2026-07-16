# 参与贡献 Contributing

感谢你愿意为 SquadFlow 做贡献！

## 开始之前

- 大的功能或架构改动请先开 issue 讨论，避免白做工。
- Bug 修复和小改进可以直接提 PR。

## 开发环境

1. 使用 Node.js 22 与 npm 10。
2. 运行 `npm run setup` 从锁定文件安装依赖（构建脚本不会隐式安装依赖）。
3. 运行 `npm run dev` 启动开发环境。

## 提交 PR

1. 从 `main` 拉分支，保持改动最小且聚焦——每个改动都应能对应到明确的需求或缺陷。
2. 代码改动跑通 `npm run check`（类型检查 + lint + 全部测试）。
3. 涉及渲染层、Electron、启动流程或打包的改动，额外跑 `npm run desktop:package` 与 `npm run desktop:smoke`。
4. 行为变更请附带或更新测试。
5. PR 描述里写清楚动机与验证方式。

## 红线

- 不要提交凭证、应用数据、生成的安装包、打包的运行时二进制、缓存或个人路径。
- `apps/local-service/` 是唯一的后端实现，不要引入其他后端。
- 保持稳定行为与协议契约有代码和测试覆盖。
