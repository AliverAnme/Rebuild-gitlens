# Sync Release 工作流

自动同步并打包 [gitkraken/vscode-gitlens](https://github.com/gitkraken/vscode-gitlens) 最新 release 版本的工作流。

一个便于个人使用及测试的自动编译环境，同时实现了部分汉化

---

## 功能特性

- 支持手动指定版本或自动获取最新版本
- 自动检测本地是否已存在对应 tag，避免重复打包
- 自动安装依赖并打包生成 vsix 安装包
- 自动创建 GitHub Release，包含变更日志

## 触发方式

### 定时触发

工作流默认每天凌晨 0 点自动执行，自动拉取并打包最新 release 版本。

```yaml
schedule:
    - cron: '0 0 * * *'
```

### 手动触发

通过 GitHub Actions 页面手动触发，可选择指定版本或使用默认的最新版本。

1. 进入仓库的 **Actions** 页面
2. 选择 **Sync Release** 工作流
3. 点击 **Run workflow**
4. 可选：输入版本号（如 `v17.8.1`），留空则获取最新版本
5. 点击 **Run workflow** 按钮执行

## 输入参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `version` | string | 否 | 最新版本 | 要同步的 release 版本号，格式为语义化版本号（如 `v17.8.1`）。留空则自动获取最新版本 |

## 工作流程

1. **版本解析** - 解析用户输入的版本号，若留空则通过 GitHub API 获取最新 release 版本
2. **本地检测** - 检查本地仓库是否存在该版本的 tag，若存在则跳过打包流程
3. **代码获取** - 从上游仓库 `gitkraken/vscode-gitlens` 拉取指定版本的代码
4. **Release 信息** - 获取上游 release 的变更日志
5. **代码检出** - 切换到指定版本的代码状态
6. **依赖安装** - 执行 `pnpm install` 安装项目依赖
7. **打包构建** - 执行 `pnpm package` 生成 vsix 安装包
8. **发布 Release** - 在当前仓库创建对应版本的 GitHub Release，上传 vsix 文件

## 目录结构要求

```
.
├── .github/
│   └── workflows/
│       └── build.yml
└── package.json
```

## 输出产物

- **vsix 安装包**：位于仓库根目录，命名格式为 `gitlens-{version}.vsix`
- **GitHub Release**：包含vsix 安装包

## 注意事项

1. **版本格式** - 输入的版本号必须以 `v` 开头，且为有效的语义化版本号

## 示例

### 同步指定版本

在 GitHub Actions 页面输入版本号：`v17.8.1`

### 同步最新版本

在 GitHub Actions 页面直接点击运行，不输入版本号

### 查看执行结果

1. 进入仓库的 **Actions** 页面
2. 点击对应的 workflow run
3. 查看 **Summary** 了解执行详情
4. 在 **Releases** 页面下载生成的 vsix 文件

## 相关链接

- [vscode-gitlens 官方仓库](https://github.com/gitkraken/vscode-gitlens)
- [GitLens 官网](https://gitlens.amd.com/)
- [VSCode Extension 发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
