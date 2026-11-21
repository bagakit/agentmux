# 独立窗口的原位提示

使用 `verify-workbench-window-return.mjs --restart-only` 启动私有 Electron，沿真实窗口 owner 移出同一个 Tab。查看 Space 深色的移出中间帧与静态终帧、窄 Focus 浅色，以及矮 Focus 的减少动效。两处提示在同一原窗口与文档上提供定位和召回，动效期间动作可点击。

验收点击真实提示的两个动作，核对原窗口和文档回执、原输入节点和草稿。重新开窗后退出，另一真实进程恢复同一个 Tab 窗口和 Survey 窗口。使用受控输入，验证期间只操作私有窗口。

视觉约束归[独立窗口的呈现](../../../../../docs/design/presentation/spaces-and-layout.md#工作面的独立窗口)。
