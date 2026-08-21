# Global Board / Task Inspector MVP（草案）

状态：Draft，三页交互已验证；视觉原型需要按成熟产品界面约束重做后再纳入实现任务计划。

## 目标

验证一个完整的全局 Multi-card Board：用户能从全局任务池发现 Task，选择 Task 后在右侧查看任务事实，并以复用既有 Region arrangement 的方式观察关联 Session。编排调度 Agent 保持浮窗；任务执行 Agent 只在 Task Inspector 中以只读 Region 投影展开，明确跳转到 Project 工作台才离开 Board。

## MVP 页面

1. **Global Board**
   - 全局导航、Project/状态/优先级/标签筛选和搜索。
   - 少量稳定 Task 状态列与完整任务卡。
   - 默认不显示固定左栏；有来源与依据时显示按需入口。
   - 卡片显示 Task ID、标题、目标 Project、状态、优先级、最新事件、Attempt/Agent 摘要和下一步动作。
2. **Task Inspector：单/多 Session**
   - 选中卡片后右侧固定详情面板，Board 保持可见。
   - 详情分 Summary / Execution / Activity。
   - Execution 复用 `WorkbenchViewLayout` 的 split-tree 和 arrangement preset，单 Session 单 Region，多 Session 以 columns/grid/balance 排布。
   - 每个 Region 显示 Project/Workspace/Branch/Topic/Session 和“进入项目”按钮。
   - Region 默认 mirror/read-only，复用同一个 Session/Run/PTY/Replay/Gap/attachment owner；不创建第二个进程。
3. **Default Session：浮窗与任务草案**
   - 浮动/顶栏收纳两种入口位置。
   - 编排 Agent 对话、Project 路由理由、Task 草案、拆分与风险。
   - 创建前显示分析→目标 Project→待创建，创建后显示 Task receipt；不把编排对话复制到 Task Inspector。
   - 默认 Session 作为默认 Topic 持续积累项目路由、风险判断和用户确认记录；确认策略可切换，默认按风险确认。

## 明确不在 MVP

- 固定三栏批注墙。
- 右侧镜像 Region 的 PTY 输入和独立 resize owner。
- 右侧投影直接修改 Project 的持久 Tab/Region 布局。
- Agent 自动跳转 Project 工作台。
- Provider 专属的 Board 实现或第二套 Runtime。
- 营销式 hero 标题、底部演示页切换器、无语义的多彩线框和发光装饰。

## 实现纵切顺序（草案）

1. Task / Project / Attempt / Session 关联的只读投影与选中状态。
2. Task Inspector 临时 layout state，复用现有 arrangement algebra，不污染 Workspace layout。
3. SessionRegionHost 抽取：WorkspaceWorkbench 与 Task Inspector 共用 Session surface/attachment 生命周期。
4. Project 深链：精确跳转至现有 Session 所在 Project/Workspace/Branch/Topic/Region。
5. 默认 Session 浮窗、Task 草案和 Board Task receipt。
6. 来源与依据抽屉，以及重启后的 Task Inspector arrangement 恢复。

## 验收方向

- Board 是完整主界面；Task 是唯一主对象，Session 作为关联执行事实。
- 单/多 Session 右侧 Region 能复用既有布局语言，切换 Task 不会修改 Project 工作台布局。
- 每个 Region 能精确打开其所属 Project 工作台，失败时保留任务和 Session 投影。
- 右侧投影不会启动第二个 ctxmux Run/PTY；输入与尺寸控制仍由原工作台拥有。
- 默认 Session 创建 Task 后，卡片、详情和来源与依据能互相定位。
- Task 写入遵守用户选择的确认策略；每次确认形成可检索的默认 Topic 决策记录，学习结果只影响建议，不绕过确认闸门。
- 首屏直接进入 Board 工作面；没有营销式大标题、底部演示导航或无语义的彩色线框。
- Task drawer 与 Default Session 面板附着在 Board 上；工具栏和操作使用紧凑按钮组，状态色不扩散成装饰色块。
- 选中 Task、打开详情或展开 Region 不改变页面路由；Region 复用当前 Agent Session 的既有 surface/attachment 方式，只在详情中做观察投影。
- Default Session 浮窗直接加载默认 Topic 的原生 Tab/Region 与 composer，不另造复杂聊天界面；Task 草案和确认策略作为轻量工作面状态出现。
- 每个 Topic 可配置自己的 Wiki 注入；默认 Topic 默认加载 AgentMux 使用、Project 路由、需求合并和追问规则，并显示可检查的版本/来源状态。
