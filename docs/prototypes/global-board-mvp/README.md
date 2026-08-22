# Global Board / Task Inspector MVP 原型

这是一个静态交互草图，用于确认全局 Board 的成熟产品信息架构和视觉方向，不连接 Runtime，也不代表已交付实现。

打开 `index.html`：

- 初始状态是完整的全局 Multi-card 任务界面。
- 点击 Task 后，Board 右半边直接变成 Task 工作区；中间以多 Region 展示关联 Agent 正在工作的 terminal。
- 点击顶部或右下的 Default Session 入口，加载默认 Topic 的原生 Tab/Region 和 composer。

原型刻意保留三个关键约束：

1. 左侧“来源与依据”默认收起，不做固定批注墙。
2. 执行 Agent 默认只读投影；“进入项目”才跳转工作台，并复用同一 Session/Run/PTY。
3. Task 卡是主对象，Agent/Attempt 是卡片和 Task 工作区内的关联事实。
4. 产品表面不使用营销式 hero、大标题、底部演示切换器或多彩装饰线框；工具栏、卡片和详情使用中性 Surface、hairline 分隔和紧凑按钮组。
5. Default Topic 不再模拟独立聊天产品，直接复用原生 Topic tab/region/composer；Wiki 注入只显示轻量加载状态。
