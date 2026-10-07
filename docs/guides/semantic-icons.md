# 开发与扩展语义图标

本指南面向开发受控 UI 的作者。产品约束归[语义图标呈现 SSOT](../design/presentation/shared-rules.md#语义图标密度与性能)，本文说明当前实现入口与操作步骤。Provider、项目等身份资产沿原身份 owner，不当作通用图标替换。

## 先按含义选择

在仓库根目录运行：

```sh
pnpm icons:dev
```

打开命令输出的地址即可浏览当前源码目录、搜索功能与语义 ID、比较主题及编辑预览。开发服务监听原目录、字形、共享呈现和消费源码；变更后自动刷新，浏览器草稿按原语义身份恢复。默认固定 loopback 端口，端口占用时明确报错；可用 `pnpm icons:dev --port 4187` 指定另一端口，或加 `--open` 在系统浏览器打开。不同 origin 的草稿不共享，可用页面导入/导出迁移。

先找相同产品含义，再选 `SemanticIconId`。两个含义恰好使用相同图形时仍保留各自身份。例如历史记录使用 `object.activity`，当前产出使用 `status.working`。页面中的源码引用只用于定位消费，动态前缀候选不证明实际覆盖或运行事实。

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

## 添加新含义或新图形

1. 先检查 [SEMANTIC_ICON_CATALOG](../../packages/client-ui/src/theme/icon-catalog.ts)。只有新的产品含义才新增稳定 ID，并填写准确 `label` 与默认 `glyph`；复用现有类别前缀。不要为尺寸、颜色或动画新增 ID。
2. 默认图形已在库中时直接引用 `IconGlyphId`。确需新绘图时，在 [ICON_GLYPHS](../../packages/client-ui/src/theme/icon-glyphs.ts) 登记数据式 24 单位 SVG 几何，核对小尺寸、主题笔触与授权来源。不要在业务组件粘贴第二份路径。
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
| Settings、公共发现和工具的目录投影 | `icon-catalog-metadata.ts` |
| React 与原生 sprite 投影 | `icons.tsx`、`icon-sprite.ts` |
| 实例呈现参数与共享动效 | `icon-presentation.ts`、`styles/semantic-icons.css` |
| 用户主题资产及校验 | `schema.ts`、原 theme runtime |

这些文件均属于 `packages/client-ui/src/`。工作台的中文注释和源码引用是审阅辅助；图形与目录默认始终来自上述 owner。
