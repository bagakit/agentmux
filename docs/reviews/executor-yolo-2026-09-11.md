# Claude / Codex 一键 YOLO

Review: approved. 用户明确要求参考 Refproj 的一键 YOLO；范围为 Claude 与 Codex，包括绑定这两个 Provider 的自定义 Executor。

复用现有 Executor args 与 config.save，不新增权限配置 owner；设置顶部一键开启并立即保存，也允许单个 Executor 开启。保留 model、effort、命令与环境，清除冲突的已知权限参数。只承诺后续启动/恢复的参数，不修改现有 Session 或 Provider 全局配置，不宣称绕过 Provider 的强制策略。

验证：挂载设置组件，点击后检查保存 payload、错误提示和禁用状态；验证最终 Provider launch/resume argv。变异去掉实际应用接线应使测试变红，恢复后变绿。生产调用者排除定义文件。

Claude 排查证据：当前用户 settings.json 包含 permissions.blockReadsOutsideWorkingDirectories=true，而 2026-09-09 与 2026-09-10 备份未设置。本机 Claude 2.1.268 对该选项的 schema 描述明确为 every permission mode，并在无法分析 shell 读取范围时产生 outsideReadsBlocked 的 ask。尚未拿到用户这次确认框的完整上文，不将此具体弹窗标为已确诊；也没有证据证明 CODEX_CI 导致沙箱。
