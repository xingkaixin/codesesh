# Release Guide

本指南描述从上一 Git tag（例如 `v0.9.0`）发布下一补丁/次版本（例如 `v0.9.1`）时的仓库内步骤。npm 发布与 GitHub Release 由推送 tag 后的 CI 自动完成。

## 版本与发布物

| 位置 | 作用 |
|------|------|
| `packages/cli/package.json` | **npm 包 `codesesh` 的版本**（`pnpm publish` / Release workflow 以此为准） |
| `packages/core/package.json` | 与 monorepo 内其他包对齐（workspace 依赖，不单独发 npm） |
| `apps/web/package.json` | Web UI 构建时注入 `__APP_VERSION__` |
| `apps/www/package.json` | 产品站包版本，与其余 workspace 包保持一致 |
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

4. 在 `apps/www/src/data/changelog.ts` 顶部新增同版本的产品更新条目。英文、中文、日文都要同步，内容规则见下文“产品更新日志”。

5. 发布日期使用 tag 对应日期的 `YYYY-MM-DD`（通常与打 tag 当天一致），技术 changelog 与产品更新日志保持一致。

## 产品更新日志

产品更新日志面向正在使用或评估 CodeSesh 的人，回答三个问题：这次改了什么、对使用者有什么影响、这反映了怎样的产品方向。它不是 `CHANGELOG.md` 的缩写，也不直接复制 commit 或 PR 标题。

每个公开版本原则上都在 `apps/www/src/data/changelog.ts` 增加一条记录，并按最新版本在前排序：

- `title`：用用户能感知的结果命名，不用内部模块名或发布类型命名。
- `summary`：先给结论，说明本版对速度、可靠性、安全、工作流或支持范围的实际影响。
- `highlights`：选 2-4 个最重要的变化，每项同时说明能力和使用价值；纯重构只有产生可感知结果时才写。
- `direction`：说明这些工作背后的长期判断，避免把尚未承诺的功能写成路线图。

写作与 SEO 要求：

- 使用目标用户会自然搜索的产品语言，例如“本地 AI 编码历史”“会话搜索”“完整回放”，但不要堆叠关键词。
- 保留准确的产品名、版本号和发布日期，避免无法从发布内容证明的数字或效果承诺。
- 三种语言表达相同事实，但应按各语言自然改写，不逐字直译。
- 技术实现细节放在 `CHANGELOG.md` 与 GitHub Release；产品页面只保留理解价值所需的细节，并链接到对应 tag。

产品站首页展示最新条目，`/changelog/`、`/zh/changelog/`、`/ja/changelog/` 展示完整记录。页面的 canonical、hreflang、结构化数据和 `sitemap.xml` 都由同一份数据生成，无需手工同步版本 URL。

## 发布清单（仓库内）

按顺序完成

- [ ] **Changelog**：更新 `CHANGELOG.md`、`CHANGELOG_CN.md` 新版本区块
- [ ] **产品更新日志**：更新 `apps/www/src/data/changelog.ts` 的英文、中文、日文条目
- [ ] **版本号**：将下列文件的 `"version"`  bump 到目标版本（四者保持一致）：
  - `packages/cli/package.json`
  - `packages/core/package.json`
  - `apps/web/package.json`
  - `apps/www/package.json`

  改完后本地自检（与 CI、Release workflow 用的是同一个脚本）：

  ```bash
  node scripts/release-preflight.mjs vX.Y.Z
  ```

  常规 CI 只做包与包之间的一致性检查（不带参数）；Release workflow 在 build 与
  publish 之前用 tag 再校验一次，任何一处漂移都会在改动 `packages/cli/package.json`
  之前失败。
- [ ] **README（按需）**：若本版有用户可见的新能力、Agent 列表或 CLI 行为变化，更新：
  - `README.md`
  - `README_CN.md`
  - `packages/cli/README.md`  
  纯 bugfix / 内部解析修复且文档已准确时，可跳过。
- [ ] **产品落地页（按需）**：若定位文案、Agent 列表或长期功能描述需随版本更新，修改 `apps/www/src` 下对应组件或文案。单个版本的变化只写入产品更新日志。

发布前验证产品站：

```bash
pnpm --filter @codesesh/www build
```

构建产物中应包含三种语言的更新日志页面与 `/sitemap.xml`。


## 版本策略（简要）

- **补丁** `x.y.Z`：bugfix、小改进、文档/落地页仅版本展示更新
- **次版本** `x.Y.0`：新功能、新 Agent、明显行为或 API 变化
- 发次版本时，changelog 中保留上一 minor 的完整历史即可；不必改旧 tag
