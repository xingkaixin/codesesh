# Rust 原生制品验证

项目默认构建和启动入口已切换到 Rust CLI；此目录负责原生打包与安装验收，不发布任何 npm 包。版本从根 Cargo workspace 读取；当前 1.0.12 只用于隔离安装验证。平台包名暂按迁移计划的 `@codesesh/cli-*` 使用，正式发布前仍须核实 scope 权限。

## 构建与打包

需要 Node.js 22+、npm、Rust 1.90 工具链、对应 Rust target/linker，以及支持 gzip 的 tar（macOS/Linux 系统 tar 或 Windows 内置 bsdtar）。脚本自身无额外 npm 依赖。Windows 通过 Node 调用 npm-cli.js，避免 cmd shell 转义和 npm.cmd 的 execFile 问题。

先构建 Web，再在每个目标的原生 runner 上构建和验证。所有目标应消费同一份已构建 Web；构建脚本不会自行重建 Web。交叉编译需要额外配置 linker，不能替代对应平台运行验收。

```sh
pnpm build:web
node scripts/rust/build.mjs aarch64-apple-darwin
node scripts/rust/pack.mjs aarch64-apple-darwin
node scripts/rust/smoke.mjs --contracts
```

其他目标为 `x86_64-apple-darwin`、`x86_64-unknown-linux-gnu`、`x86_64-pc-windows-msvc`。省略 target 使用当前 OS/CPU。pack 可用第二个参数指定已构建二进制，例如：

```sh
node scripts/rust/pack.mjs aarch64-apple-darwin target/release/codesesh
```

输出位于忽略跟踪的 `artifacts/rust-packaging/<target>/`。每个目录包含平台 npm tgz、相同版本的主包 tgz、直接下载用的原生 tar.gz、SHA256SUMS 和 manifest.json。打包前检查 ELF/Mach-O/PE 架构；打包后解压两种渠道，验证其中二进制与输入文件 SHA-256 完全相同。Windows 原生压缩包包含 codesesh.exe。

四个 runner 的目录汇总后运行：

```sh
node scripts/rust/verify-set.mjs
```

此检查要求四目标齐全、版本相同、制品哈希有效、四份主包完全相同，并核对每个平台 smoke-report.json 中的版本、二进制哈希、完整后端契约与内嵌 Web 验证结果，最后产生 release-set.json。报告必须来自相应平台的实际 smoke 执行。

## npm 启动与安装验收

模板位于 `crates/codesesh-cli/npm/`。打包脚本生成 package.json，所有 optionalDependencies 固定为 workspace 的精确版本，并设置 OS/CPU，Linux 平台包额外限定 glibc。主包只解析平台包、检查版本、启动进程、转发参数/环境/stdio/信号及退出码。没有安装脚本、网络下载、编译器依赖或旧后端回退。平台不支持、包缺失、版本不符和启动失败均明确报错。

`node scripts/rust/smoke.mjs` 在带空格和中文的临时目录使用离线 npm install，显式禁用安装脚本并排除开发依赖。它校验安装后二进制哈希、直接执行、launcher 与 npm exec 的版本、帮助输出、错误退出码、平台包缺失错误，然后清理临时目录。

`--contracts` 是 P6 完整验收的必要参数。它另外使用直接二进制和安装后的 npm launcher，分别运行已有后端进程契约，包括扫描、HTTP、持久化、SSE 更新和退出；还会读取内嵌首页、SPA 路由、JS/CSS 资源。结果写入 smoke-report.json，记录版本、Node/npm、二进制 hash 和验收时间。安装目录脱离仓库，但最低 glibc 和完整浏览器流程仍需要各自专项门禁。纯安装 smoke 通过不能代替这些检查。

```sh
node --test scripts/rust/packaging.test.mjs
```

架构检查负例防止文本、截断文件、错误 CPU 或 OS 被误标成对应平台制品。

## 当前验收证据与剩余工作

macOS arm64 已在 Node 24.21.0 / npm 8.3.1 上实际完成打包与完整安装 smoke，npm 安装脚本关闭；原生压缩包、平台包、安装后二进制 hash 一致。原生二进制与 npm launcher 各通过 3 个后端进程契约，并读取共 16 个内嵌 Web 资源，覆盖首页与 SPA 路由。具体二进制 hash 和时间以该目标 smoke-report.json 为准；后续代码变化需要重新打包验收。另三个平台尚未在此本地环境运行，当前没有最低 glibc 兼容性承诺。

根 package:artifact 与 package:smoke 已使用原生打包和安装验证，主包采用本文的 launcher 与精确版本 optionalDependencies。默认 build 先构建 Web，再构建内嵌资源的 release 二进制；源码启动使用 scripts/run-native.mjs。CI 按四个原生目标构建并验收，实际结果以对应运行报告为准。正式发布属于 P8，仍未授权；`scripts/rust/publish.mjs` 仅由正式发布工作流调用；它先核对注册表中同版本制品的实际摘要，再按平台包、主包顺序发布。本轮仅验证模拟注册表与进程调用，不执行真实发布。
