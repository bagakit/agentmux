# 给功能追加设置

设置通过源码模块在编译期组合。新增功能不需要修改 SettingsPanel 的功能分支、Overview 的摘要 switch 或 CLI 的 get/set dispatcher。模块仍使用现有 AppConfig 与唯一 Main ConfigOwner，编译后随产品交付。

## UI 贡献

在 `apps/desktop/src/renderer/src/components/settings/modules/` 定义模块，并在同级 `settings-modules.ts` 的唯一数组注册。可从现有 `general.tsx` 或 `appearance.tsx` 参照：

```tsx
export const featureSettingsModule = {
  id: 'feature',
  group: 'preferences',
  title: 'Feature',
  description: 'One sentence about what people can change.',
  keywords: 'words people search for',
  icon: FeatureIcon,
  savedSummary: (config) => readSavedFeatureSummary(config),
  Pane: FeatureSettingsPane
} as const satisfies SettingsModule
```

模块的元信息同时用于侧栏、窄窗菜单、搜索和 Overview；`SettingsSectionId` 从注册数组的 literal id 派生，不另维护一份类型名单。`overview` 是呈现页，不能作为模块 ID；ID 在注册数组内唯一，组使用现有 Preferences 或 Resources，顺序由该数组表达。

`Pane` 定义在模块作用域，不能在每次渲染时生成新的组件函数。壳只在首次访问时挂载编辑器，随后保留同一个实例；`active` 表达当前是否可见。像 Executor 这样的精确目标，仅在 `active` 时触发原焦点能力。`savedSummary` 只读已保存 config 与原默认解析器，不读取编辑草稿或触发诊断。

小设置优先加入现有领域模块的 Pane，保持原设置组与控件语言；不为每个字段新增一级入口。功能的保存适配留在模块，继续调用 `api.config.save(next, expected)`：提交值和编辑时捕获的基线分别传入，保存时合并当前无关字段。Browser 这类嵌套域不能用旧快照覆盖后来的 toolbar 或链接选择。原 draft/save hooks、空列表删除、pending 后续输入与冲突反馈继续复用。

## CLI 贡献

在 `apps/desktop/src/main/settings/modules/` 的所属领域声明 scalar；新领域在 `settings/setting-catalog.ts` 的唯一 Main 数组组合。现有 boolean/enum helper 复用同一合法值检查与有效默认值语义：

```ts
booleanSetting('feature.enabled', false,
  (config) => config.feature.enabled === true,
  (config, enabled) => ({ ...config, feature: { ...config.feature, enabled } }))
```

这是字段声明的形状示例，当前没有 `feature.enabled` 配置。新增实际 AppConfig 字段时，必须同时明确类型、默认值、生效范围与 ConfigStore 的持久化校验；注册模块不自动创造可保存的字段。新字段随后由原 `agentmux settings get <key>` 与 `agentmux settings set <key> <value>` 消费，不增加 CLI 解析分支或任意路径 setter。

Main 通过原 ConfigOwner 排队，持久保存、Runtime commit 与发布完成后才回复成功。有效默认未改变时不回填配置或写盘。资源 CRUD、权限选择等有独立合同，不能为了套进 scalar helper 而降低原身份、引用与 expected 校验。当前公开 prefix 仍仅为原支持范围，模块名称不自动成为 CLI target，输出继续明确 `partial: true`。

## 修改后的验证

运行专用模块测试与桌面 typecheck；同一 Feature 的完整门还包含实际 Source 变异与定义文件之外的产品调用者检查：

```sh
node node_modules/vitest/vitest.mjs run --config apps/desktop/scripts/fixtures/settings-modules/vitest.config.mts --maxWorkers=1
pnpm --filter @agentmux/desktop typecheck
node apps/desktop/scripts/verify-settings-modules.mjs
```

模块测试在真实组合入口追加第九个测试模块，再走产品的目录、Overview、菜单、搜索与 Pane；该模块不进入发行目录。Main 测试从持久化 schema 反推实际 scalar，防止新增字段只有 UI、没有 CLI。改变字段或模块后维护对应的行为测试与 owning 变异，不能只改两份名单让测试继续通过。

两个环境各有一个静态组合入口，Renderer 的 React 编辑器不会进入 Main 或通用 Core。此机制支持 Agent 修改源码后构建新功能；运行中的第三方模块热加载与卸载不在本合同内。
