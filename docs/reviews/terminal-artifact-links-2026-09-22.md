# Terminal system artifact links review

## Scope

终端里被识别为 Workspace 内路径的系统可处理文件（`.app`、`.dmg`、`.pkg`、`.exe`、`.msi`、`.deb`、`.rpm`、`.AppImage` 与常见压缩包）必须交给本机系统打开，不再被 `openFile` 投影为编辑器 Tab。任何已识别路径在右键菜单中提供平台对应的 Finder/File Explorer/File Manager 揭示动作；不可归一化的路径和普通输出不显示动作。远端 Workspace 不宣称本机系统打开。

## Protected invariants

- Renderer 只提交 Workspace id + 相对路径；Main 复用 WorkspaceFiles 的根内与真实路径校验。
- HTTP(S) 链接仍走既有 Browser destination picker；文件动作不改变 Browser 的 scheme 处理。
- 系统打开或揭示失败必须通过既有错误出口显式呈现。
- 菜单命中判定是纯字符串/几何逻辑，不能在 xterm hover/click 热路径做磁盘探测。

## Review decision

Approved for implementation as one Feature with two Tasks: (1) typed Main/preload/renderer seam and artifact classification, (2) terminal context-menu path actions and end-to-end wiring. Task 2 depends on Task 1. Verification must include focused behavior tests, Desktop typecheck, a production caller check, and mutation evidence for artifact routing and context-menu visibility.
