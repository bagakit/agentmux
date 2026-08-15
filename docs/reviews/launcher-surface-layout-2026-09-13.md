# 启动页布局与控件语汇复审（2026-09-13）

status: approved

## 缘起

用户给出截图并问：「这个页面目前还是布局和样式都相当不合理的状态, 是没修还是新版本没发」。

先答这一问，再谈修法。

## 是没修，不是没发

三条独立证据，结论一致——**没修**：

1. `git log fc791a21..HEAD -- apps/desktop/src/renderer/src/styles/surfaces.css` 为空。
2. 已装版本（fc791a21）与待发版本（9440318a）各自的 `.launch-surface` 规则集
   md5 相同（`77317d5f16ef4f729dd3dd3aa5e85370`），`diff` 为空。
3. 调查期间 HEAD 版本被并发的打包任务装上（12:13:47 换的
   `package-identity.json`，12:15:23 重启），页面**布局未变**。

另：feature-tracker 的 26 个 active feature 与归档里都没有一条覆盖启动页布局；
这一屏最后一次被实质排版是 2026-07-26（`481f1f16`）。

## 七个缺陷与它们的共同根

截图上能指出的问题逐条落到源码后是七个（D1–D7）。它们分两组，**根因不是同一个**，
所以分开写——把它们合并成一句「缺少视觉测试」会让四个静态可查的缺陷继续无人守。

### 为什么会被写出来（R1/R2）

- **R2（主）：`justify-content: space-between` 被当成「把东西摊开」的通用手法。**
  它的结果是子元素个数的**纯函数**：两个子元素＝两端对齐，三个＝三等分。
  而那份「这里有几簇」的预期活在 `.css` 里，子元素活在 `.tsx` 里，两者之间没有任何东西绑定。
  于是 `.launch-surface__footer` 在 Resume 按钮出现的那一刻从「左信息 / 右主操作」
  变成三等分，Launch 按钮被甩到正中间。
  **跨表面预测并已证实**：`.settings-pane-toolbar` 同样有一个正确调用方
  （`HostSettingsPane.tsx:78`，两个子元素）和一个错误调用方
  （`AgentSettingsPane.tsx:207`，3–4 个散放子元素）。
- **R1：一档控件被按「档位名」另造了一个类名。** `.secondary-button` 被写出来过一次
  （启动页 Resume），全仓零规则；`base.css` 的全局 `button` 只重置 `font`/`color`，
  **不重置 `background`**，于是它落到 macOS 原生按钮样式——一颗浅灰实心药丸，
  在深色主题里比紧邻的品牌绿主操作还重。

### 为什么没被逮住（R3）

**守卫的判据按构造就看不见它。** `rendered-class-has-rule.test.ts` 的
`isBemToken` 要求类名含 `__` 或 `--`，扁平的 `-button` 整族在扫描面之外——
这不是「漏登记了一条」，是结构性缺席。同理，设计文档把规则写成表格里的散文，
而不是带机器可派生名字的封闭断言。

### 明确否决的两个「根」

- **「没有视觉测试」不是根。** 七条里有五条是静态可判的（类名无规则、
  死规则、arity 契约、装饰色、读数与动作不一致），一个像素都不需要。
  happy-dom 不算布局是事实，但拿它当根会让那五条继续没人守。
- **「缺少控件语汇层」不是根。** 213 个扁平类名里只有 1 个没有规则，
  五档里四档 CSS 健康。造一个 Button 组件正是原则 2 禁止的预防性抽象。

## 逐条缺陷

| 编号 | 缺陷 | 归属 |
|---|---|---|
| D1 | `.secondary-button` 零规则 → macOS 原生灰药丸 | R1 |
| D2 | `.composer__toolbar` 四个散放子元素，簇数随 Provider 在 2–4 浮动 | R2 |
| D3 | `.launch-surface__footer` 的 `space-between` 在 Resume 出现时三等分 | R2 |
| D4 | `.agent-catalog` 只有 margin，11 个 Agent 摊成三行把 prompt 顶下屏 | 密度合同未落地 |
| D5 | `.launch-surface__icon` 品牌绿装饰格 | 控件语言（与 Settings hero 格同族） |
| D6 | Resume 报出 N 个候选却恒定恢复第 0 个 | 读数与动作不指向同一对象 |
| D7 | `.new-tab-surface` / `.new-tab-grid` 整块死规则 | 改版后未删 |

## 落地顺序

1. 设计 SSOT 先行（两份 design 文档）。
2. 控件语汇 + 守卫判据形状（D1）。
3. 目录预算（D4）。
4. Resume 选择器（D6）。
5. 表层清理（D7、D2、D3、D5）。

## 本轮明确不做

- 不造 Button 组件（预防性抽象）。
- 守卫不钉死 268/142/44 这三个数——数抄进测试就活在两个地方，改一处即漂。
- 不加「装饰绿分类器」守卫、不加 arity 的子元素计数守卫、不引入 Playwright/像素对比。
- `AgentSettingsPane.tsx:207` 那第四处 arity 实例、dock 的装饰绿格、
  `agent.css` 的 `::before` 选中条——**记录但不改**，超出启动页范围。
