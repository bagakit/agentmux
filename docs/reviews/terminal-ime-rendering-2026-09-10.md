# 终端输入法与画面稳定性

Review: approved

用户要求排查中文输入后光标前移再输入导致旧文本重复，以及输出中画面乱码、缩放才恢复；拉取最新 reference project 对照其输入法和渲染处理。先定位可复现的因果边界，修复在唯一输入出口、组合事件与尺寸同步所有者处，不复制 Runtime。验收需覆盖连续中文组合、光标移动、候选确认及重绘/尺寸恢复的事件顺序，以变异与非空生产调用闭合；原生输入法实测结果与合成事件证据分开报告。

Reference: reference project fast-forwarded to origin/main `7dd183d82d`. AgentMux used xterm 5.5, whose CompositionHelper starts at textarea length and commits through its end. Upstream 6.1.0-beta.303 uses selectionStart/End and excludes the prior suffix, directly addressing mid-line insertion. Use the same upstream versions as reference project without copying its whole application patch. WebGL 0.20.0-beta.299 tracks atlas pageLayoutVersion per renderer; older shared invalidation could be consumed by only one pane. Both application shortcut owners now defer IME-owned keys through the existing isImeOwnedKeyboardEvent.

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
