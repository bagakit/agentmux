# 终端重绘反馈

Review: approved

用户明确要求修复 scrollback 提示常驻、Redraw 无反馈。历史缺失由 ctxmux 决定，重绘不能清除缺失事实；请求成功收起横幅为带说明的标记，无法执行和异常保留解释与重试。验收覆盖实际按钮、异步成功/失败/不可执行和生产接线；以变异红绿证明反馈判断有效。

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
