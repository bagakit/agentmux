# 给功能追加设置

设置通过源码模块在编译期组合。新增功能不需要修改 SettingsPanel 的功能分支、Overview 的摘要 switch 或 CLI 的通用解析器。模块仍使用现有 AppConfig 与唯一 Main ConfigOwner，编译后随产品交付。

现有页面、字段、管理入口及 CLI 支持范围集中在[设置目录](settings-catalog.md)。追加真实设置时同步该目录，默认值与范围继续由字段源码和公开查询持有。

## UI 贡献

在 `apps/desktop/src/renderer/src/components/settings/modules/` 定义模块，并在同级 `settings-modules.ts` 的唯一数组注册。可从现有 `general.tsx` 或 `appearance.tsx` 参照：

```tsx
export const featureSettingsModule = {
  id: 'feature',
  archetype: 'preference',
  group: 'preferences',
  title: 'Feature',
  description: 'One sentence about what people can change.',
  keywords: 'words people search for',
  icon: FeatureIcon,
  savedSummary: (config) => readSavedFeatureSummary(config),
  Pane: FeatureSettingsPane
} as const satisfies SettingsModule
```

模块的元信息同时用于侧栏、窄窗菜单、搜索和 Overview；`SettingsSectionId` 从注册数组的 literal id 派生，不另维护一份类型名单。注册时守住以下约束：

- `overview` 是呈现页，不能作为模块 ID；ID 在注册数组内唯一。导航标题可以与 ID 不同，例如 Club 与 Note 的标题不改变既有 `mote`／`notes` 分区 ID；Mods 组的 ID 是 `toolkit`，入口为 Toolkit Library。
- 组使用现有目录中的组身份。组顺序由 `settings-catalog.ts` 的唯一 `SETTINGS_GROUPS` 表达，注册数组决定组内次序，所有导航投影沿同一目录。各组实际包含哪些页面见[设置目录](settings-catalog.md)，产品分组与范围见[设置行为合同](design/behavior/settings-and-observation.md#设置页的信息架构)，具体设置结构沿[设置分区合同](design/behavior/settings-and-observation.md#分区资源与配置生效)。
- 分组和管理入口不建立另一套配置或授权 owner：模块保持原偏好和管理 owner，不复制共享编辑表单，不把只读参考包装成可写偏好。管理入口本身不生成 AppConfig 或新 CLI；只有新增实际偏好字段才补 Main scalar 与公开调用者。
- 支持选中动作的图标由模块 `selectionAnimation` 显式声明，不从组名推断，以免移动模块时丢失反馈。

`archetype` 是必填的呈现类型：`preference`、`library`、`console` 或 `reference`。按真实内容选择；资源库和只读参考不必为了评估添加表单控件。字段定义见 [SettingsModule](../apps/desktop/src/renderer/src/components/settings/settings-catalog.ts)，各类型的阅读目标与测量判据由[呈现合同](design/presentation/settings-and-observation.md#分区层级与通用反馈)持有。

模块的 `icon` 贡献表达准确目的地；先复用共享目录中的同一产品语义，确有独立含义缺口再按[语义图标指南](guides/semantic-icons.md)扩展。已有 `semanticIconComponent` 提供稳定的语义组件，不能在业务模块复制 SVG、直接绑定库字形或再维护一张模块默认图标表。侧栏、Overview、搜索与窄窗导航消费同一贡献；外部渠道可复用本模块原 `channel.icon` 的品牌组件。辨识与用户主题边界归[模块图标身份](design/presentation/settings-and-observation.md#模块图标身份)。

外部对话平台的原设置模块可通过可选 `channel` 元信息贡献准确 `adapterId`、平台域、显示名称和图标；设置目的地沿同一模块 ID 派生。公共菜单与标题栏消费原目录的唯一匹配投影，未识别的平台保原域和通用图标。该呈现不表达平台支持、权限或收发资格；实际实现能力沿原 Connection 公共记录读取，不从名称、图标或 enrollment 能力猜测。

模块可用 `searchTargets` 贡献具体字段、动作或说明的静态 `id`、`title`、可选 `description` 与 `keywords`；原 Pane 用同一局部 ID 的 `data-settings-field` 标记准确位置。动作和说明分别声明 `kind: 'action'`／`'info'`，其余为设置字段。搜索只消费这些静态贡献，明确点选后才进入原 Pane 并定位；不扫描用户值、正文或隐藏页，不执行动作。动态资源仍经原库与准确对象导航；不要为其每个当前对象生成静态目标。行为与恢复边界见[设置页的信息架构](design/behavior/settings-and-observation.md#设置页的信息架构)。

`Pane` 定义在模块作用域，不能在每次渲染时生成新的组件函数。壳只在首次访问时挂载编辑器，随后保留同一个实例；`active` 表达当前是否可见。像 Executor 这样的精确目标，仅在 `active` 时触发原焦点能力。`savedSummary` 只读已保存 config 与原默认解析器，不读取编辑草稿或触发诊断。

小设置优先加入现有领域模块的 Pane，保持原设置组与控件语言；不为每个字段新增一级入口。AppConfig 偏好的保存适配留在模块，通过唯一 [saveConfigSlice](../apps/desktop/src/renderer/src/components/settings/save-config-slice.ts) 提交：

```ts
await saveConfigSlice(
  (current, notes: Required<NotesPreferences>) => ({ ...current, notes: { ...current.notes, ...notes } }),
  value,
  expected
)
```

这是现有 Notes 阅读偏好的适配形状，`value` 为草稿，`expected` 为开始编辑时捕获的基线。真实签名为 `saveConfigSlice<T>(slice, value, expected): Promise<AppConfig>`；`slice(current, value)` 与 `slice(current, expected)` 都基于 store 的当前配置构造完整 AppConfig。helper 调用 `api.config.save(next, expected)`，仅在没有更新的配置发布时采纳原保存回执；配置尚不可用时明确失败并保留草稿，不报告保存成功。Browser 等嵌套域仍须在 slice 中保留未编辑字段，不能用旧快照覆盖后来的 toolbar 或链接选择。原 draft/save hooks、空列表删除、pending 后续输入与冲突反馈继续复用；资源事务与 Notes 目录等独立 owner 不经过这一 helper。

## CLI 贡献

在 `apps/desktop/src/main/settings/modules/` 的所属领域声明 scalar；新领域在 [setting-catalog.ts](../apps/desktop/src/main/settings/setting-catalog.ts) 的唯一 Main 目录组合。现有 [scalar helper](../apps/desktop/src/main/settings/scalar-setting.ts) 复用同一合法值检查与有效默认值语义：

```ts
booleanSetting('feature.enabled', false,
  (config) => config.feature.enabled === true,
  (config, enabled) => ({ ...config, feature: { ...config.feature, enabled } }))
```

这是字段声明的形状示例，当前没有 `feature.enabled` 配置。普通枚举用 `enumSetting`；闭区间整数用 `integerSetting(key, { min, max }, defaultValue, read, write)`，它在查询中给出当前值、默认值与合法整数集合。含继承标记或跨字段规则的特殊整数条目保留原 entry/apply，并复用 `parseIntegerSettingValue(key, text, min, max)` 校验整数词法及安全范围；例如 [Appearance 的编辑器字号](../apps/desktop/src/main/settings/modules/appearance.ts) 另处理继承值，不复制另一份数字解析。新增实际 AppConfig 字段时，必须同时明确类型、默认值、生效范围与 ConfigStore 的持久化校验；注册模块不自动创造可保存的字段。新字段随后由原 `amux settings inspect <key>` 与 `amux settings set <key> <value>` 消费，不增加 CLI 解析分支或任意路径 setter。公共接口影响与完整交付按[公共能力贡献约定](guides/public-capability-contributions.md)判断。

Main 通过原 ConfigOwner 排队，持久保存、Runtime commit 与发布完成后才回复成功。有效默认未改变时不回填配置或写盘。已有独立持久 owner 的设置在同一组合入口声明 `ownedSettings`，实现 [OwnedSetting](../apps/desktop/src/main/settings/owned-setting.ts) 的 `key`、`unavailableCode`、`inspect()` 与 `apply(value, requestId)`；例如 [notes.directory](../apps/desktop/src/main/settings/modules/notes.ts) 复用 NotesStorageOwner 的 inspect/change、原 operation ID 与 expectedDirectory，不复制存储事务。宽范围查询可以保留其它条目并返回具名 issue；精确查询保留该 owner 的失败，不能用默认值冒充读取成功。

资源 CRUD、权限选择等有独立合同，不能为了套进 scalar helper 而降低原身份、引用与 expected 校验。当前公开 prefix 从 Main 声明的精确键及父前缀派生，见[设置目录的查询方式](settings-catalog.md#查询与修改)及 Main dispatcher；模块名称不自动成为 CLI target，输出继续明确 `partial: true`。个人资料、Focus 与 Goals 示例沿此机制，不增加独立解析器或配置 owner。

新增 optional 偏好域时，沿 [config-edit 的 authored 合并](../apps/desktop/src/shared/config-edit.ts)核对首次编辑：默认值参与比较，但不能因此把未编辑字段写盘；并发首次写入不同字段仍须互相保留。Notes 与 Goals 可作为此边界的现有参照。

## 修改后的验证

运行专用模块测试与桌面 typecheck；同一 Feature 的完整门还包含实际 Source 变异与定义文件之外的产品调用者检查：

```sh
node node_modules/vitest/vitest.mjs run --config apps/desktop/scripts/fixtures/settings-modules/vitest.config.mts --maxWorkers=1
pnpm --filter @agentmux/desktop typecheck
node apps/desktop/scripts/verify-settings-modules.mjs
node node_modules/vitest/vitest.mjs run apps/desktop/test/settings-catalog-doc.test.ts
```

模块测试在真实组合入口追加一个仅测试使用的模块，再走产品的目录、Overview、菜单、搜索与 Pane；该模块不进入发行目录。Main 测试从持久化 schema 反推实际 scalar，防止新增字段只有 UI、没有 CLI。改变字段或模块后维护对应的行为测试与 owning 变异，不能只改两份名单让测试继续通过。

呈现评估使用真实 SettingsPanel 的隔离 Electron Renderer，默认采集全部分区、宽／窄窗与明暗模式；也可限定实际分区。命令和参数由 [采集脚本](../apps/desktop/scripts/capture-settings-evaluation.mjs) 持有，阈值只沿上面的呈现合同：

```sh
node apps/desktop/scripts/capture-settings-evaluation.mjs --check-schema
node apps/desktop/scripts/capture-settings-evaluation.mjs --sections appearance,notes --assert first-screen,type
node apps/desktop/scripts/capture-settings-evaluation.mjs --assert language,jargon
node apps/desktop/scripts/capture-settings-evaluation.mjs --assert all
```

报告与图片写入本机忽略目录，保留各项指标与问题；未知分区、空集合、参数错误或渲染失败都不能当作通过。`state-unavailable` 说明隔离夹具没有该连接或服务的真实业务状态，不能证明对应业务通过。采图与测量也不代签审美验收；视觉修改仍须[独立 Agent 看图评审](guides/agent-visual-e2e-review.md)。

两个环境各有一个静态组合入口，Renderer 的 React 编辑器不会进入 Main 或通用 Core。此机制支持 Agent 修改源码后构建新功能；运行中的第三方模块热加载与卸载不在本合同内。
