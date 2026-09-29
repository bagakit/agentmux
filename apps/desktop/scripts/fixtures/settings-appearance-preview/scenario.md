# Appearance 静态配色样片

沿实际 `App → SettingsPanel → appearance module → AppearanceSettingsPane` 操作。约束只见交互 SSOT《设置页的信息架构》和密度 SSOT《Settings 控制工作面》：样片属于静态配色选择，原 native radio、草稿与明确 Save 保持。

运行 `node apps/desktop/scripts/verify-settings-appearance-preview.mjs --capture-only` 采一个新私有候选；它不覆盖旧图。普通命令读取同目录 current pointer，核 Source/compiled/PNG/raw 精确字节并消费独立看图 PASS。原 radio/draft 18 个测试和 Source mutations 使用 Task 中的有限命令。

场景只有 940 浅色、940 深色、320 深色三个完整窗口。实际非空 catalog 与 palette radio 身份相等；逐主题滚到可见，再按 Text Range 读取两个样本每个非空白字形，核单行与实际裁剪祖先。原生键盘检查准确的可见 connected 相邻控件、组内选择与出组；真实私有 ConfigOwner 接 next/expected，只应用 palette 差异并保其他配置字节。默认字体来自实际 shared contract；省略配置的语义 default 与提交值、owner 差异应用是三个明确事实。

Range 不证明 paint。probe 同时记录实际 computed color/opacity 与原生 bitmap，并读回最终保存的完整 PNG，逐字形及 chrome dot 检查像素并非单色。它只是一条漏画反证，不能代替独立审美、证明旧缺画根因、或推断用户 GPU/渲染卡顿已经修复。历史纯黑 Graphite 图与此前 oracle 失败都保留。

`--mutations` 在独立私有 compiler inputs 里改实际 Pane：旧长文、多行溢出、空主题映射，各命中特定 owning assertion，再精确恢复 GREEN；不写共享 Main。Renderer/ConfigOwner/ConfigStore 均来自实际 Source，IPC 接缝使用私有 profile，不连接用户 App/Runtime/Run，不创建 Terminal，也不签 OS 偏好、安装或实时会话性能。
