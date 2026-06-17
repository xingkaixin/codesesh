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

按顺序完成；勾选后再打 tag。

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
- [ ] **验证**：

  ```bash
  pnpm install
  pnpm lint
  pnpm test
  pnpm build
  ```

- [ ] **提交**：单独 commit 发布准备（示例信息）：

  ```text
  chore(release): prepare v0.9.1
  ```

## 打 tag 与推送

```bash
git tag -a v0.9.1 -m "v0.9.1"
git push origin main
git push origin v0.9.1
```

也可先 push commit，再 push tag；**必须**推送匹配 `v*` 的 tag 才会触发 Release workflow。

## CI 自动步骤（`.github/workflows/release.yml`）

在 `push: tags: v*` 时：

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm --filter codesesh run release`（`BUNDLE_CORE=true`，打包 CLI 并复制 web dist）
4. 从待发布的 `packages/cli/package.json` 移除 workspace 依赖 `@codesesh/core`
5. `npm publish --provenance --access public`（工作目录 `packages/cli`）
6. `softprops/action-gh-release` 创建 GitHub Release（`generate_release_notes: true`）

本地无需执行 `npm publish`，除非你在做预发布演练。

## 落地页部署（可选）

仓库脚本 `pnpm deploy:www` 部署 Cloudflare 上的产品站。若希望线上落地页显示新版本号，在 bump `apps/www` 版本后执行部署（按你们现有运维流程）。

## 示例：v0.9.0 → v0.9.1

| 步骤 | 本版说明 |
|------|----------|
| 变更范围 | `#54` Claude usage 去重；`#55` Pi resume 命令 |
| 版本 | `0.9.0` → `0.9.1`（四处 `package.json`） |
| Changelog | 已写入 0.9.1 节 |
| README | 未改（Pi resume 为既有「恢复命令」能力的补全；Claude 为成本准确性修复） |
| 落地页 | 仅 `apps/www/package.json` 版本号；Hero 自动显示 `v0.9.1` |

## 版本策略（简要）

- **补丁** `x.y.Z`：bugfix、小改进、文档/落地页仅版本展示更新
- **次版本** `x.Y.0`：新功能、新 Agent、明显行为或 API 变化
- 发次版本时，changelog 中保留上一 minor 的完整历史即可；不必改旧 tag

## 故障排查

- **npm 版本未更新**：确认 tag 指向的 commit 已包含 `packages/cli/package.json` bump。
- **Web UI 仍显示旧版本**：确认 `apps/web` 已 bump 且 release 前 `pnpm build` / CLI `release` 脚本已复制最新 `web` dist。
- **落地页仍显示旧版本**：确认 `apps/www` bump 后已重新 build/deploy；勿只改 `apps/www/dist` 手工产物。