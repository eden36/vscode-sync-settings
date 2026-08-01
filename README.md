# Profile Git Sync

通过普通 Git 仓库自动同步 VS Code、Cursor 及其全部用户 Profiles 的便携配置。插件支持多个 IDE 窗口同时运行：同一 User Data 目录只会选出一个 leader 执行 Git 与 AI 操作，其余窗口作为 follower 转发同步请求。

## 当前能力

- 一次快照默认 Profile 与全部命名 Profile 的 `settings.json`、`keybindings.json`、`tasks.json`、`extensions.json`、`mcp.json`、`snippets/` 和 `prompts/`。
- VS Code 与 Cursor 分别存放在 `.profile-git-sync/hosts/vscode` 和 `.profile-git-sync/hosts/cursor`，不会互相覆盖。
- 自动拉取、三方合并、提交和推送；不会使用 force push。
- 优先通过 AI 生成中文 commit message；AI 不可用或结果无效时使用固定的中文 Conventional Commit，不阻塞同步。
- 同一文件被本机和远程同时修改时，优先由 AI 生成候选并要求确认；AI 不可用时采用本机有效内容优先、远程修改优先于本机删除的确定性兜底。
- 优先使用 VS Code `chat.utilitySmallModel` 指定的小模型，无法使用时回退到 IDE 通过 Language Model API 开放的默认模型，无需配置 API Key；疑似含有明文凭据的配置会被拒绝提交。
- Profile 增删属于结构变化。多个窗口运行时只暂存，不直接改写 VS Code 内部 Profile 元数据。
- 侧边栏同步概览实时显示当前状态和上次成功同步时间，时间在 IDE 重启后保留。
- 侧边栏可直接开关自动同步并设置本地检测与远程轮询间隔；默认分别为 60 秒和 600 秒。

## 开发

```powershell
npm install
npm run check
npm test
npm run package
```

在 VS Code 或 Cursor 中打开项目后按 `F5`，会先构建插件，再自动打开 Extension Development Host。调试实例的 User Data 保存在工作区 `.debug/`，但会加载本机已安装的扩展，以便使用 Copilot 等扩展提供的默认 AI 模型。

需要验证多窗口时，可在已打开的调试宿主中执行“新建窗口”，并选择不同 Profile；这些窗口共享同一个隔离 User Data，适合观察 leader/follower 状态。

生成的 `profile-git-sync-0.1.0.vsix` 可通过 VS Code 或 Cursor 的“从 VSIX 安装”功能安装。

## 使用

打开活动栏中的“配置同步”，填写 Git 仓库和分支。Git 用户名和邮箱是可选项：留空时继承本机 Git 配置，填写时只覆盖插件同步仓库的提交身份；SSH 密钥或 HTTPS 凭据始终使用本机 Git 配置。提交信息与冲突候选优先使用 `chat.utilitySmallModel` 配置的模型；该设置为空或模型未向扩展开放时，回退到当前 IDE 暴露的默认模型。宿主没有开放模型或 AI 返回无效结果时，插件自动使用确定性兜底并继续同步。

建议使用 SSH 或系统 Git Credential Manager 管理 Git 凭据，不要把凭据写进仓库 URL。插件需要应用到所有 Profiles；否则仅打开未安装该扩展的 Profile 时，不会有实例负责自动同步。

## 同步边界

“全部配置”指可跨设备迁移的用户 Profile 配置。扩展不会同步登录凭据、SecretStorage、缓存、工作区存储、机器专属路径和远程开发环境状态。VS Code 没有公开的“枚举并恢复所有 Profiles”扩展 API，因此本项目使用带格式校验的磁盘适配器；IDE 升级后应先在测试仓库验证兼容性。
