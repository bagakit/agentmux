# Agent-native Browser Workspace

## 用户结果

Browser 不只负责打开网页，还要把网页上下文安全地带给 Agent。当前确认的 Browser 工具如下：

- 外部打开固定放在 Browser bar 最左侧，使用单独指向右上角的箭头图标；该入口始终显示，不能被工具栏配置隐藏。
- 原来的“抓取元素”和“给元素加批注”合并成一个“选择元素”入口。用户先在页面上选择元素，再决定复制上下文或添加批注，不让两个按钮争夺同一个选择动作。
- 原来的画笔入口在产品概念上叫“截屏”。进入后冻结当前网页画面，再提供画笔、高亮、箭头、图形、文字、撤销和重做，完成后得到一张可交给 Agent 的 PNG。
- DevTools 保留，但使用能直接表达开发者工具的图标，不再使用含义模糊的方框代码图标。
- 视口设置保留，使用明确的预设尺寸并允许恢复默认自适应尺寸。
- 更多菜单保留。除了固定显示的外部打开，Browser bar 上的“选择元素”“截屏”“DevTools”“视口”和“更多”都能在 Browser Tools 中配置是否显示；即使隐藏“更多”，Browser Tools 仍是恢复这些入口的权威配置面。
- Profile 的创建、导入、切换和管理放在 Workspace 的 Browser Tools，不在 Browser bar 再维护第二套管理入口。导入 Browser Profile 的含义是把已支持浏览器的可用登录会话导入 AgentMux 自己的隔离 Session，而不是让 AgentMux 运行时读取外部浏览器目录。

## 所有权与依赖方向

- Electron Main 的 `BrowserViewManager` 是 Browser WebContents、Session partition、Profile、导航、权限、DevTools、截图、视口和页面选择执行的唯一 owner。
- Preload 只暴露窄的 typed Browser IPC；Renderer 不持有 WebContents、Cookie、Profile 目录或 DevTools 生命周期事实。
- Renderer 的 Browser bar 和 Browser Tools 只投影 Main 的结果，并保存纯展示偏好。工具显隐不改变底层能力与安全策略。
- Browser 元素上下文、批注和截屏只有在用户显式复制或发送后才进入 Agent 输入；Renderer 不把它们伪装成 Core Timeline 事实。提交给 Agent 时继续走现有 Composer/Core prompt owner。
- `packages/core` 不依赖 Electron Browser，也不新增 Browser Runtime。Browser 仍是 Desktop Host capability。

## Profile 与隐私边界

- 每个 Profile 使用独立、持久化的 Electron Session partition；切换 Profile 会让当前 Browser View 使用目标 partition 重新创建，不复制 Renderer 状态冒充切换成功。
- 导入只在用户显式选择来源后发生，来源探测不在启动时扫描。
- 导入 owner 验证来源、限制数据量并原子写入目标 Session；失败不留下部分导入的 Profile。
- 不持续读取或同步外部浏览器目录，不保留明文凭据副本，不增加无权限 fallback、旧格式 migration 或另一套 Cookie Store。

## 选择元素与批注

- Main 在当前 WebContents 中安装一次有界选择脚本，返回经过裁剪和脱敏的结构化结果：页面标题与去查询参数 URL、元素角色与可访问名称、选择器、可见文字、安全属性、附近文字、有限 HTML、几何信息和可选 PNG。
- 页面提供的字符串按不可信输入处理；脚本、事件属性、凭据样式属性和值、URL 查询与 fragment 不进入结果。
- 同一选择结果可以“复制上下文”或“添加批注”。批注必须绑定 `browserId + navigation identity + element geometry`；导航后旧批注明确失效，不静默贴到另一页面。
- 多条批注在 Browser Tools 中可查看、删除并一次发送给当前 Agent Composer；未发送批注属于 Desktop Browser 草稿，不属于 Core Activity 或 A2A Conversation。

## 截屏

- “截屏”使用 Main-owned WebContents `capturePage` 冻结当前可见 viewport；Renderer 只编辑这张冻结图片。
- 编辑能力为画笔、高亮、箭头、矩形、椭圆、文字、颜色/粗细、撤销、重做和清空。
- 完成后输出有像素与字节上限的 PNG。第一条交付路径是复制到系统剪贴板，并允许通过已有 Composer 图片附件合同发送；如果该合同尚未存在，不能用临时文件路径或字符串占位冒充附件。

## Browser bar

从左到右的稳定顺序是：

1. 外部打开；
2. Back / Forward / Reload；
3. 地址栏；
4. 选择元素；
5. 截屏；
6. DevTools；
7. 视口；
8. 更多。

窄宽度下地址栏先收缩，工具按钮保持单行并使用 tooltip；隐藏入口不留下空槽。所有按钮有可访问名称、disabled 状态与键盘 focus，不依赖图标猜含义。

## 非目标

- 不复制 a mature workbench 的 Store、daemon、`<webview>` owner、账号系统、Remote Browser 或 Agent Browser Runtime。
- 不在 `packages/core` 新增 Browser WebContents 或 Cookie owner。
- 不增加旧 Browser 配置兼容、migration、fallback 或双写。
- 不把 Profile 导入扩展成浏览器密码、历史、书签或扩展同步。
- 不因实现截图绘制而建立通用 Canvas 框架。

## 公开验收

- Main owner 测试证明 Profile partition、显式导入、DevTools、截图、视口、元素选择、导航失效和关闭清理。
- Typed IPC 与 Renderer 测试证明稳定 toolbar 顺序、显隐配置、外链不可隐藏、合并选择入口和 Browser Tools Profile 管理。
- Production Electron 验收真实 WebContentsView：外部打开、DevTools、viewport、元素选择、批注、截图 PNG、Profile 切换/导入与关闭后资源释放。
- 未缩小的 `pnpm test:fast`、`pnpm check` 和 production build 绑定同一候选；既有 harness blocker 必须如实报告，不能用 exclude 或 fallback 冒充绿灯。
