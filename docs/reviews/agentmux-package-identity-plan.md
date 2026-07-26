# AgentMux packaged artifact identity and install boundary

状态：approved（用户已确认需要收敛打包心智，并要求清理旧包、安装最新候选）

## 问题

同一 `0.1.0` 版本号下同时存在 `apps/desktop/out`、
`apps/desktop/release/mac/AgentMux.app`、`/Applications/AgentMux.app` 和
`~/Applications/AgentMux.app`。这些路径没有共同的、可机器核对的来源身份，
因此用户从旧 LaunchServices 副本启动时，会误以为源码回退，实际是安装包落后。

## 决策

1. `apps/desktop/out` 仍是构建中间产物；唯一可安装候选是同一次 clean build
   生成的 `apps/desktop/release/mac/AgentMux.app` 与 DMG。
2. 候选在 bundle 内写入 `package-identity.json`，绑定源码 commit、tree、应用版本、
   平台和架构。tree 取实际 index tree；只要 worktree 与 index 一致即可打包，
   任何 unstaged/untracked 变更仍会阻断。打包 Gate、package report 与安装输出都
   读取这份身份，不只看 `CFBundleVersion`。
3. `package:mac:install` 只原子替换 `~/Applications/AgentMux.app`，并在替换前后
   验证候选身份和代码签名；失败时保留现有安装。
4. 不新增运行时、Session、Run 或 UI 状态；来源身份只属于打包/诊断边界。

## 验证边界

- 单元测试覆盖身份生成、字段完整性和 commit/tree/version/platform/arch mismatch。
- package report 必须输出 bundle 内身份；现有 macOS package Gate 继续验证
  clean source、签名、DMG、LaunchServices 和 runtime。
- 安装后通过 report 与 `shasum` 核对 release 候选和 `~/Applications` 使用同一
  Main/Renderer 内容；不依赖用户手工猜测路径。

## 非目标

- 不自动删除用户的 Application Support、Session、Run 或其他非包数据。
- 不把 `/Applications` 与 `~/Applications` 继续当作两个受支持的安装入口；已有
  非规范副本由显式清理动作处理。
