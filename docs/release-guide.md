# Release Guide

本指南描述从上一 Git tag（例如 `v0.9.0`）发布下一补丁/次版本（例如 `v0.9.1`）时的仓库内步骤。npm 发布与 GitHub Release 由推送 tag 后的 CI 自动完成。

## 版本与发布物

| 位置 | 作用 |
|------|------|
| `packages/cli/package.json` | **npm 包 `codesesh` 的版本**（`pnpm publish` / Release workflow 以此为准） |
| `packages/core/package.json` | 与 monorepo 内其他包对齐（workspace 依赖，不单独发 npm） |
| `apps/web/package.json` | Web UI 构建时注入 `__APP_VERSION__` |
| `apps/www/package.json` | 产品落地页 Hero 等读取 `packageJson.version` 展示 `vX.Y.Z` |
| Git tag `vX.Y.Z` | 触发 `.github/workflows/release.yml` |

根目录 `package.json`（`codesesh-monorepo`）为 `private`，**无需**改版本号。

CLI 运行时版本来自 `packages/cli/src/version.ts`，读取 **同目录** `packages/cli/package.json`，勿手写版本常量。

## 发布前：整理变更

1. 确认上一 tag 已存在且 main 已包含待发内容：

   ```bash
   git fetch --tags
   git log v0.9.0..HEAD --oneline
   ```

2. 按 PR / commit 归类为 **Features**、**Bug Fixes**、**Performance**、**Build**、**Documentation** 等（与 `CHANGELOG.md` 既有结构一致）。

3. 中英文各写一节：`CHANGELOG.md`、`CHANGELOG_CN.md`。建议包含：
   - 顶部的用户可读摘要（含 PR 编号）
   - 可选的 **Changelog Detail**（`#N type(scope): subject @author`）

4. 发布日期使用 tag 对应日期的 `YYYY-MM-DD`（通常与打 tag 当天一致）。

## 发布清单（仓库内）

按顺序完成

- [ ] **Changelog**：更新 `CHANGELOG.md`、`CHANGELOG_CN.md` 新版本区块
- [ ] **版本号**：将下列文件的 `"version"`  bump 到目标版本（四者保持一致）：
  - `packages/cli/package.json`
  - `packages/core/package.json`
  - `apps/web/package.json`
  - `apps/www/package.json`
- [ ] **README（按需）**：若本版有用户可见的新能力、Agent 列表或 CLI 行为变化，更新：
  - `README.md`
  - `README_CN.md`
  - `packages/cli/README.md`  
  纯 bugfix / 内部解析修复且文档已准确时，可跳过。
- [ ] **产品落地页（按需）**：`apps/www` 版本展示来自其 `package.json`，一般 **仅 bump 版本即可**；若营销文案、Agent 列表或功能点需随版本更新，改 `apps/www/src` 下对应组件/文案。


## 版本策略（简要）

- **补丁** `x.y.Z`：bugfix、小改进、文档/落地页仅版本展示更新
- **次版本** `x.Y.0`：新功能、新 Agent、明显行为或 API 变化
- 发次版本时，changelog 中保留上一 minor 的完整历史即可；不必改旧 tag
