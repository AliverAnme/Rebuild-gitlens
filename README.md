<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Rebuild GitLens - 自动同步上游 GitLens release、应用本地补丁并打包成可安装 vsix 的 GitHub Actions 工作流">
</p>

<h1 align="center">Rebuild GitLens</h1>

<p align="center">
  <a href="https://github.com/aliveranme/Rebuild-gitlens/releases"><img src="https://img.shields.io/github/v/release/aliveranme/Rebuild-gitlens?color=2ea44f&logo=github" alt="Latest Release"></a>
  <a href="https://github.com/aliveranme/Rebuild-gitlens/actions/workflows/build.yml"><img src="https://github.com/aliveranme/Rebuild-gitlens/actions/workflows/build.yml/badge.svg" alt="Build Status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">用于个人使用及测试的 GitLens 自动构建工作流，支持自动同步上游最新发布并编译打包</p>

---

## 📖 这是什么

一个 GitHub Actions 工作流，自动同步 [gitkraken/vscode-gitlens](https://github.com/gitkraken/vscode-gitlens) 的最新 release，应用本仓库的本地改动（结构化改写脚本），构建出可直接安装的 `.vsix` 文件及 SHA-256 校验和，并自动发布到本仓库的 [Releases](https://github.com/aliveranme/Rebuild-gitlens/releases)。

## ⚙️ 工作流机制

1. **同步上游版本** — 从 `gitkraken/vscode-gitlens` 拉取指定 tag 或最新 release。
2. **应用本地改动** — 运行 `scripts/apply-patches.mjs`，按**函数名**定位并重写目标函数。每条改动都带 `--expect-version`（构建的必须是解析出来的那个版本）与 `--assert-fresh`（这一轮必须把每一条都改到）；任何一条被误判成「已应用」都会让构建变红，而不是悄悄出一个少打补丁的包。
3. **构建扩展包** — 执行 `pnpm install`、`oxfmt` 代码规范化与 `pnpm package` 编译；编译内部会并行跑 `oxlint --type-aware --type-check --deny-warnings`、依赖检查、l10n 检查与格式检查，任一不过即构建失败。
4. **发布 Release** — 计算 SHA-256 校验和，附上上游 CHANGELOG 对应版本的条目，并在发布后校验 `.vsix` 与 `.sha256` 确实挂到了 Release 上。

## 🚀 触发方式

### 手动触发

进入仓库 **Actions → Fix gitlens and build**，点击 **Run workflow**：

- **指定版本**：输入版本号（如 `v19.0.1`）即可定向同步并编译该版本
- **最新版本**：留空则自动检测并拉取上游最新的正式 release

### 定时触发

默认每天 UTC 0:00 自动触发检查与构建：

```yaml
schedule:
  - cron: '0 0 * * *'
```

## 📦 输出产物

以 v19.4.0 为例（文件名里的版本号**不带** `v` 前缀）：

- **`.vsix` 安装包**：`gitlens-19.4.0.vsix`
- **SHA-256 校验和**：`gitlens-19.4.0.vsix.sha256`
- **GitHub Release**：包含安装文件、校验和与上游 CHANGELOG 中该版本的条目

下载后可以自校验：

```bash
sha256sum -c gitlens-19.4.0.vsix.sha256
```

## 🛠️ 本地改动说明

改动不再以 `.patch` 形式存放 —— 传统的 `git apply` 补丁会把每处改动**周围的代码**一起锁进 hunk 上下文，上游只要在目标函数旁插入或重排代码，整个补丁就会失效（这正是历史上反复需要「重新生成补丁」的原因）。

现在改为 `scripts/` 下的结构化改写脚本：

| 文件 | 作用 |
|------|------|
| `scripts/apply-patches.mjs` | 入口：定位上游 checkout、应用全部改动、生成 diff 与汇总；`--check` 为只读校验模式 |
| `scripts/lib/codemod.mjs` | 无依赖的 TS 扫描原语：代码掩码、括号配对、按函数名定位函数/形参/顶层 `return`/调用表达式/对象顶层属性 |
| `scripts/lib/rules.mjs` | 4 项本地改动规则 |
| `scripts/__tests__/` | 零依赖单测（`node --test scripts/__tests__/*.test.mjs`） |

| 规则 | 作用说明 |
|------|------|
| `account-access-not-required` | `isAccountAccessRequired()` 恒返回 `false`，解除 Commit Graph 强制登录限制（Bypass sign-in） |
| `subscription-state-paid` | `computeSubscriptionState()` 恒返回 `SubscriptionState.Paid`，订阅状态直通付费态 |
| `community-subscription-is-enterprise` | `getCommunitySubscription()` 改为注入已验证企业账户（`Voyager`）并提升至 Enterprise，支持离线与免登录使用 |
| `checkin-subscription-is-enterprise` | `getSubscriptionFromCheckIn()` 的最终返回值改为 Enterprise 计划，保留真实个人信息 |

每条改写都会在被改的函数体里留下一个**哨兵标记**（如 `// local-change:checkin-subscription-is-enterprise`），`isApplied()` 只认这个标记。于是「这条改动到底有没有打上」是一个**事实**，而不是「代码看起来像不像」的推断 —— 这正是本仓库最需要防的那类故障：构建全绿、产物却少了一条补丁。

两侧的不变量由脚本直接断言：全新 checkout 必须 `4 modified, 0 already applied`（`--assert-fresh`），二次运行必须 `0 modified, 4 already applied`（`--assert-applied`）；命令行参数写错（缺值、`--check` 与 `--diff` 同用、未知参数）会立刻 exit 1，而不是静默按默认值跑。

> 📘 **要新增一条改动，或上游重构后要修既有规则？完整规程见 [`docs/ADDING-A-CHANGE.md`](./docs/ADDING-A-CHANGE.md)** —— 机制总览、规则契约、扫描原语速查、两个可复制模板、五条铁律、排错速查表、重新发布与回滚 runbook。

### 上游重构后怎么办

脚本失败时会以 `::error file=...::` 标注**具体是哪条规则、哪个函数**找不到锚点，并在 Job Summary 里输出实际生成的 diff。完整的「报错 → 原因 → 处置」对照表见 [排错速查表](./docs/ADDING-A-CHANGE.md#9-排错速查表)。此时只需：

1. 打开 `scripts/lib/rules.mjs`，找到报错的规则；
2. 对照上游新代码调整「从哪里取、写回什么」；
3. 本地验证：

```bash
# 只校验不写入
node scripts/apply-patches.mjs --root /path/to/vscode-gitlens --check

# 实际应用并导出 diff 供审阅
node scripts/apply-patches.mjs --root /path/to/vscode-gitlens --diff local-changes.diff

# 幂等 + 单测（CI 的两道闸门）
node scripts/apply-patches.mjs --root /path/to/vscode-gitlens --check --assert-applied
node --test scripts/__tests__/*.test.mjs
```

> 注意：`src/plus/gk/utils/__tests__/subscription.utils.test.ts` 断言的是上游原始订阅状态逻辑，构建流程不运行单测，因此本地改动后该文件仍会失败——这是预期行为。

## 💻 快速安装指南

### 命令行一键安装

```bash
# VS Code
code --install-extension gitlens-*.vsix

# Cursor
cursor --install-extension gitlens-*.vsix

# VSCodium
codium --install-extension gitlens-*.vsix
```

### 图形界面安装

1. 打开编辑器侧边栏 **Extensions（扩展）** (快捷键 `Ctrl+Shift+X` 或 `Cmd+Shift+X`)。
2. 点击扩展面板右上角的 **`···` (Views and More Actions)**。
3. 选择 **Install from VSIX...（从 VSIX 安装...）**，选择下载的 `.vsix` 文件即可。

## 🌐 兼容性支持

| 编辑器 / 平台 | 兼容状态 | 说明 |
|---|---|---|
| **VS Code** | 兼容 | 原生支持 |
| **Cursor** | 兼容 | 支持免登录及全部基础/高级特性 |
| **Trae** | 兼容 | 支持完整图谱及相关视图 |
| **Windsurf** | 兼容 | 原生支持 |
| **VSCodium / OpenVSCode** | 兼容 | 支持离线安装 |

## ⚠️ 使用提示

- 手动指定版本号必须以 `v` 开头（例如 `v19.0.1`）
- 若仓库已存在对应 tag，工作流会**整体跳过**这次构建（避免重复打包），因此已发布的坏版本不会因为重跑而自愈
- 要重发某个版本，先删掉 Release 与 tag 再触发：

```bash
gh release delete v19.4.0 -R aliveranme/Rebuild-gitlens --cleanup-tag --yes
gh workflow run "Fix gitlens and build" -R aliveranme/Rebuild-gitlens -f version=v19.4.0
```

- 重发前后的文件名与版本号完全相同，只有 `.sha256` 内容不同 —— 已下载的用户请用校验和确认自己手里的是哪一版
- 侧载的扩展不会自动更新，升级时需要重新下载安装；产物仅供个人测试与学习研究使用

## 🔗 相关链接

- [新增 / 维护本地改动指南](./docs/ADDING-A-CHANGE.md)
- [vscode-gitlens 官方仓库](https://github.com/gitkraken/vscode-gitlens)
- [GitLens 官网](https://www.gitkraken.com/gitlens)

## 📄 License

[MIT](./LICENSE)
