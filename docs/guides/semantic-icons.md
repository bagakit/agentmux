# 开发与扩展语义图标

本指南面向开发受控 UI 的作者。产品约束归[语义图标呈现 SSOT](../design/presentation/shared-rules.md#语义图标密度与性能)，本文说明当前实现入口与操作步骤。Provider、项目等身份资产沿原身份 owner，不当作通用图标替换。

## 先按含义选择

在仓库根目录运行：

```sh
pnpm icons:dev
```

打开命令输出的地址即可浏览当前源码目录、搜索功能与语义 ID、比较主题及编辑预览。开发服务监听原目录、字形、共享呈现和消费源码；变更后自动刷新，浏览器草稿按原语义身份恢复。默认固定 loopback 端口，端口占用时明确报错；可用 `pnpm icons:dev --port 4187` 指定另一端口，或加 `--open` 在系统浏览器打开。不同 origin 的草稿不共享，可用页面导入/导出迁移。

先找相同产品含义，再选 `SemanticIconId`。两个含义恰好使用相同图形时仍保留各自身份。例如历史记录使用 `object.activity`，当前产出使用 `status.working`。恢复原 Session 用 `action.resume-session`，重启终端用 `action.restart-terminal`，恢复默认配置用 `action.restore-defaults`；这三种操作分别定制，不能因为都有“恢复”字样就共用一个 ID。Topic、Tab、Zone、Region 也各有对象身份。页面中的源码引用只用于定位消费，动态前缀候选不证明实际覆盖或运行事实。

遇到一图多义，先读实际调用方的 handler、目标和所在工作流，再决定复用或新增语义身份：会话分叉与 Git 工作区创建、消息回到草稿与移动文件夹、单篇 Note 与 Notebook 集合分别核对。同一功能目的地跨 Desktop/Mobile 选择同一语义项，尺寸仍按各自宿主设置。确认含义独立后，再查现有 `IconGlyphId` 是否足够；分开定制不要求分开画图。改接线时保留原控件、可访问名称、命中区和回调，业务状态、权限与原回执不随绘图变更。

通用工具记录使用 `conversation.tool-call`／`conversation.tool-result`，沿原结构的记录种类选择，不能因为标题像命令就借 `object.terminal`；真实终端对象继续沿其原角色。调用与返回的静止、失败和成功边界见[过程层级与详情](../design/presentation/conversation-mode.md#过程层级与详情)。

## 在产品中使用

React 从公开入口引用，并加载共享样式：

```tsx
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import '@agentmux/client-ui/styles/semantic-icons.css'

// 原应用根已经挂载主题运行时。标题默认静态。
<SemanticIcon name="status.working" size={14} />

// currentlyProducing 来自原调用方已确认的当前事实。
<SemanticIcon name="status.working" color="var(--success)"
  animation={currentlyProducing ? 'work' : 'none'} />

// 需要组件类型的列表配置，在模块级定义。
const WorkingIcon = semanticIconComponent('status.working')
```

原生 DOM/编辑器适配使用同一投影：

```ts
import { createSemanticIconElement } from '@agentmux/client-ui/icons'

const node = createSemanticIconElement('object.activity', document, { size: 14 })
container.append(node)
```

静态 native 调用返回 SVG；显式动画可能返回包含同一 SVG 的 HTML 载体，应保留返回节点，不假定动画节点是 SVG。新宿主在应用根沿现有 [theme runtime](../../packages/client-ui/src/theme/runtime.ts) 挂载一次主题与 sprite；业务图标不单独挂载运行时。

参数以 [SemanticIconPresentation](../../packages/client-ui/src/theme/icon-presentation.ts) 为准，支持尺寸、颜色、线宽、端点、连接及有限动画预设。明确参数优先于 inline style，再继承主题笔触和上下文颜色。默认静态；标题、历史与未知状态按呈现合同处理。按钮仍负责可访问名称，图标不能代替动作标签。

`animation="none"` 是静止态，默认就使用完整轮廓，不需要另建状态或监听。所有项目自绘都在原作者条目中同时声明 `design.rest` 与 `design.motion`，后者区分有条件循环、单次反馈和保持静止。`AUTHORED_ICON_DESIGNS` 从这些条目派生供工具展示；设计说明不作为运行、权限或成功事实。

`work` 只驱动笔，`stream` 只推进正文光标，`execute` 只推进浏览器箭头，`wait` 表现漏沙、积沙与停顿翻面，`orbit` 只转静态轨道上的短弧。这些局部循环须由原准确活动事实显式选择；沙漏和短弧均不是任务百分比或剩余时长。`feedback` 仅播放已登记的笔、加号、方向或恢复弧一次，随后回完整静止轮廓；调用方只在对应呈现或操作已应用的事实成立时选择，不能凭点击或展示文字猜成功。长期工作台中的“演示”是明确模拟，不是业务回执。需要再次播放单次反馈时，按新的明确呈现或已应用事实重建该图标实例（React 可使用对应事实的稳定 `key`，native 使用原工厂替换该实例）；持续渲染同一实例不代表新的触发，不新增重播计时器。代码类型、对象、历史、身份与精确几何没有合理动态时明确保持静止。

加载和刷新同样使用实例 `animation="spin"`，只在原调用方确认 pending 时开启。共享 `spin` 只驱动原字形登记的可旋转部位；载体、其余固定轮廓和用户未声明部位的自定义资产保持完整，不以旧 `spin` class 或页面 CSS 再旋转整枚图标。自定义为另一字形后只有该字形明确支持相应部位才恢复动作；读取文字、busy 状态和操作回执仍由原 owner 决定。

部位身份由原几何 owner 登记：项目自绘在 `icon-authored.ts`，库字形在 `icon-glyphs.ts`；CSS 动作归共享 `semantic-icons.css`，不在调用方复制路径、操作逐帧 DOM 或加整枚摇晃样式。选择其它库字形或自定义 paths 时，不猜哪段是部位，保留完整资产；切回声明部位的图形后沿原主题投影恢复。减少动态、原宿主停泊及明确 motion-off 继续适用。控件禁用规则仍归原宿主，busy 按钮中的真实加载状态不因此被一律停止。

## 添加新含义或新图形

1. 先检查 [SEMANTIC_ICON_CATALOG](../../packages/client-ui/src/theme/icon-catalog.ts)。只有新的产品含义才新增稳定 ID，并填写准确 `label` 与默认 `glyph`；复用现有类别前缀。不要为尺寸、颜色或动画新增 ID。
2. 默认图形已在库中时直接引用 `IconGlyphId`。确需项目自绘时，在 [AUTHORED_ICON_DEFINITIONS](../../packages/client-ui/src/theme/icon-authored.ts) 同一条目登记数据式 24 单位 SVG `shapes`、静止设计 `design.rest` 及 `design.motion`；类型要求每个新条目都提供完整设计。动态选择为 `still/none`、`loop/对应局部预设` 或 `once/feedback`，写清动作部位与准确触发依据，不能为了凑数让每个对象循环。原几何表和设计投影均从这一个条目派生，原 [ICON_GLYPHS](../../packages/client-ui/src/theme/icon-glyphs.ts) 自动聚合库字形与自绘并派生完整类型。核对静态单色、小尺寸、主题笔触与授权来源；同族使用一致的轮廓尺度、端点和留白，对象先画可辨轮廓，动作增加最少的方向或操作提示。不要在业务组件粘贴第二份路径，也不要手工维护工作台的自绘或状态名单。
3. [getSemanticIconCatalog](../../packages/client-ui/src/theme/icon-catalog-metadata.ts) 从目录派生元数据；只有新增类别或上下文描述时才修改其分组信息。`SemanticIconId`、glyph ID 类型也从原目录派生，无须另写 ID 清单。
4. 接到真实产品调用方并检查内置主题的显式覆盖。目录默认、主题覆盖和本次实例呈现分别由各自 owner 持有；主题文件中的 `icons[id]` 可选择登记 glyph 或合法 paths，解析与导出沿原 [schema](../../packages/client-ui/src/theme/schema.ts)。
5. 在工作台核对新语义、默认图形、浅深主题与实际小尺寸，再在真实消费界面核对含义、对齐及状态变化。测试与变异沿[测试策略](../testing/strategy.md#任务验收与假绿防护)，视觉改动沿[看图验收](agent-visual-e2e-review.md)。

Settings 图标编辑器、公开主题发现的 `iconCatalog` 与工作台消费上述目录；不需要手工更新工作台条目或默认映射。添加图形不改变业务状态或动作资格。仅改变默认图形时也要保留用户已保存的明确选择。

## 长期工具与发布快照

工作台入口在 [icon-review](../../apps/desktop/scripts/icon-review/README.md)。开发模式直接加载源码；静态发布复用同一目录生成函数，在页面标明快照身份。构建分享版本：

```sh
pnpm icons:build
```

页面预览与草稿只作用在该浏览器。完整主题导出后可在产品 Settings 导入；“导出修改”包含审阅说明与历史，供后续处理。动画/颜色实例模拟不保存成主题状态。源码更新遇到无法匹配的旧项时保留待核对记录，不丢弃草稿。

| 事实 | 实现 owner |
| --- | --- |
| 产品含义、稳定 ID、默认映射 | `icon-catalog.ts` |
| 可选 SVG 几何 | `icon-glyphs.ts` |
| 项目自绘几何、静止与动态设计及其派生投影 | `icon-authored.ts` |
| Settings、公共发现和工具的目录投影 | `icon-catalog-metadata.ts` |
| React 与原生 sprite 投影 | `icons.tsx`、`icon-sprite.ts` |
| 实例呈现参数与共享动效 | `icon-presentation.ts`、`styles/semantic-icons.css` |
| 用户主题资产及校验 | `schema.ts`、原 theme runtime |

这些文件均属于 `packages/client-ui/src/`。工作台的中文注释和源码引用是审阅辅助；图形与目录默认始终来自上述 owner。
