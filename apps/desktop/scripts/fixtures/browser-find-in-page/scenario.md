# Browser 页内查找条

行为约束：[交互 SSOT《Browser 页内查找与网页焦点下的浏览器键位》](../../../../../docs/design/behavior/browser-workface.md#browser-页内查找与网页焦点下的浏览器键位)。控件语言：[密度 SSOT《Browser 页内查找条》](../../../../../docs/design/presentation/browser-workface.md#browser-页内查找条)。本场景在 private userData 的独立窗口里挂载真实 `BrowserPane` 与查找条，不写 durable 工作面、不改变用户运行副本。

```sh
node apps/desktop/scripts/capture-browser-find-in-page.mjs
```

场景先从 More 菜单打开查找条，再实际键入查询，依次得到有结果、无结果、查找失败和未确认（`? results`）四种回答，在正常宽度（900）、窄宽度（360）与最窄受支持的双分割宽度（235）、深浅两种外观下分别截图。随后切到 Agent 控制：输入与上一项、下一项禁用，保留的查询词变淡，提示先接管。最后用 Escape 关闭，再在工具栏按 Cmd/Ctrl+F 重新打开空查找条，正常与窄宽度各一张。

几何门只核对结构事实：查找条在工具栏下方，让页面舞台让出高度，而不是浮在页面上；输入、计数、上一项、下一项和关闭都在 Pane 内可见，计数文字完整显示，只有接管提示在窄于 360 时可以省略，完整说明留在 tooltip；同一宽度下各种查找回答与空查找条的输入位置、宽度相同；窄宽度先缩短输入，输入框左缘对齐工具栏第一个图标；无结果时上一项、下一项禁用；Agent 控制时查询词与放大镜同程度变淡，且比箭头轻；关闭后页面舞台回到原高度。场景把生产样式规则临时改成覆盖层、或让计数位随文字伸缩时，对应的门必须判错，恢复后通过，证明门本身能区分对错。

查找回答是本文档内的 preview 数据。Chromium 的页内查找、Main/IPC 边界、网页焦点下的键位路由和 Agent 拒绝分别由 `browser-find-in-page.test.tsx`、`browser-recovery-preview-ipc.test.ts` 与 `browser-page-keys.test.ts` 证明，不由截图冒充。`captureOnly: true` 与 `aestheticReview: not-performed` 只表示采集完成，须由实现作者之外的 Agent 实际看完整原图后评审。
