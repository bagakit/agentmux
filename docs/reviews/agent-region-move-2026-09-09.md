# Agent 分屏搬到 Tab 的语义缺口

Review: approved

授权依据：用户报告“分屏里加载的 Agent somehow 在 tab 上又加载了一次”并提供截图，延续本会话排查修复和记录需求的授权。

证据：截图中的搬动执行为 `open agent --session … --new-tab-after self`。Renderer executeControl 的已有 Session 分支只新增投影、不移除源 Region；GUI 的 Move to New Tab 已调用 promoteRegionToTab，保留 Region 身份并从源分屏摘除。当前设计允许一个 Session 多 View，不应为修此缺口禁掉显式额外投影。

闭合方向：Agent 控制入口提供按 Region 明确移到新 Tab 的命令，复用 GUI 的 promoteRegionToTab；帮助与 --skill 明确 open 已有 Session 是额外投影，搬动须用移动命令。不得 stop/relaunch Agent，不能猜测多投影 Session 的来源 Region。

验收：从含两条 Agent Region 的 Tab 搬出其中一条，源余一条、目标一条，总投影数不变、Region/Session 身份不变，不调用 Runtime lifecycle；单 Region 已独占 Tab 时不多建 Tab；无效 Region 不改布局。用真实 CLI parser、协议解析、store 行为测试串起边界，变异移除源摘除后用例须红，生产调用排除定义文件后非空。

一项任务覆盖最小 CLI→Control→既有布局 owner 竖切，没有独立前置任务。
