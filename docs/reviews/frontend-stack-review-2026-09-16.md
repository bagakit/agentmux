# AgentMux 前端技术栈评审（2026-09-16）

## 结论

当前前端技术栈适合 AgentMux 的本地桌面、Terminal-first 和高密度观察面，本轮不更换框架。真正的成熟度问题在组件事实边界、展示策略、视觉合同和测试证据，不在 React/Vite/Zustand 本身。

| 领域 | 当前选择 | 结论 | 依据与边界 |
| --- | --- | --- | --- |
| UI | React 19 + TypeScript 5.9 | 保留 | 项目已有大量受控组件、类型收窄和 React renderer；替换框架不能改善 Core/Store owner。 |
| 桌面/构建 | Electron 43 + electron-vite + Vite 7 | 保留，补独立入口 | Electron 需要本地窗口、WebContentsView、PTY 和 preload；Vite 已能支持 Desktop 与独立 Gallery，问题是入口边界而非工具能力。 |
| 状态 | Zustand 5 | 保留，禁止向组件下沉 | Store 适合窗口级持久布局和 Session 投影；Workflow、Markdown、Composer 等表面应继续用 props/adapter。 |
| 交互原语 | Radix UI + lucide-react | 保留 | Context menu、dialog、popover 和可访问焦点已有真实消费者；Workflow 状态 glyph 只补充不同的领域状态，不复制通用交互原语。 |
| 编辑与终端 | Monaco + xterm | 保留 | 两者分别拥有 Editor 与 Terminal 的渲染事实；换成通用文本/终端组件会失去当前能力。 |
| 拖拽/布局 | dnd-kit + react-resizable-panels + @agentmux/layout | 保留，观察维护成本 | 仅在确有布局/拖拽行为时使用；Workflow 列表不引入第二套 grid/drag framework。 |
| Markdown | unified/remark-gfm | 保留 | AgentMarkdown 已经把不可信正文、文件引用和链接出口分层，替换解析器没有产品收益。 |
| 测试 | Vitest + happy-dom + 静态样式契约 | 保留，补行为/浏览器证据 | SSR/源码扫描适合纯渲染和契约；点击、焦点、响应式和跨表面视觉必须交给 Farm 浏览器验收。 |

## 建议补充

- 独立 Vite entry 是本轮唯一应新增的构建能力；它服务 DAFarm/Gallery 的静态发布，不改变桌面主入口。
- 把 Workflow 的 view-model、presentation policy 和 renderer 作为三层；不要新增通用 design-system 包、全局状态库、Storybook 依赖或运行时 schema 框架。
- 继续使用现有 token CSS。若将来需要组件文档系统，先证明 Gallery 和 Farm 证据不足，再单独评估，而不是把 Storybook 当作设计成熟度的替代品。
- 前端升级按真实缺陷驱动：先解决现有测试与组件实现的漂移，再考虑版本升级；不以升级依赖制造“现代化”外观。

## 不引入的方案

本轮不引入 Next.js、Remix、TanStack Router、Redux、XState、Tailwind、Chakra、MUI、Storybook 或另一套 CSS-in-JS。它们各自有适用场景，但当前会增加构建边界、状态 owner、样式 token 或桌面集成复杂度，不能直接改善工作流观察的清晰度。

## 证据边界

结论由 `apps/desktop/package.json`、根 `package.json`、当前 import 消费者、Vite/Electron 配置和现有测试入口派生。它不是对未来 Web SaaS、移动端或独立组件包的永久否决；这些目标出现时应另建产品模型和 Feature。
