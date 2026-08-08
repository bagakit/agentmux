# 分层更新与回切

Review: approved

用户要求参考 deepseek-harness，支持前端热更新及回切、普通宿主更新保留 Agent 重启、无法保持或恢复 Session 时先确认。

参考 `deepseek-harness/docs/cordis-tutorial/06-composition-and-hmr.md` 的稳定身份、卸载副作用、依赖所有权。采用版本化 renderer 资源与宿主指纹，复用现有进程生命周期，不引入另一套插件 Runtime。首次启用加载能力需要安装一次宿主，之后匹配指纹的 renderer 可以更新。

当前风险：草稿不在持久化名单，裸 reload 会丢现场；安装脚本超时会自动强杀。须在启用入口前解决。

验收：相容版本可切换并回退，草稿与布局保留；非前端变更不可误判热更新；退出超时不自动强杀；相同 ctxmux 的安装核对 Run 保留。实现须有变异红绿与生产调用证据。前端切换依赖安全边界，保留这条依赖。

Operator entry points: `pnpm update:local` builds and chooses frontend activation or application installation; `pnpm update:renderer` requires a compatible frontend; `pnpm update:renderer:rollback` and View > Revert frontend update switch back. First adoption requires installing the loader host. A changed ctxmux stops the update before quit, preserving the current app pending compatibility/resume assessment.

Evidence: isolated Electron 43 profile, `/tmp/agentmux-storage-probe.cjs`, exit 0. Two versioned file:// directories share localStorage; switching retains drafts, dirty buffers and layout; rollback sees edits made in the newer UI. Tests also cover cold-start readiness failure and serialized rollback during activation.

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
