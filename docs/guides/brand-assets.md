# 品牌素材指南

本页说明怎样增加、替换和核对品牌素材。品牌的结构与规则归[品牌架构](../design/presentation/brand-identity.md)；界面语义小图标另见[语义图标开发指南](semantic-icons.md)。

## 素材在哪里

所有品牌位图只有一份源文件，目录、清单字段与命名规则见[品牌源目录说明](../../packages/client-ui/brand/README.md)。

代码一律按包路径引用：`import art from '@agentmux/client-ui/brand/…'`。不要把素材复制进某个 App，也不要写跨包的相对路径。

## App 图标

1. 源图放进 `app-icons/`，在 [`app-icon-catalog.ts`](../../packages/client-ui/src/lib/app-icon-catalog.ts) 登记 id、名称、境名和材质说明。这个目录只放纯文本，因为 Main、Host 与构建脚本在 Node 下直接导入它。
2. 运行 `pnpm --filter @agentmux/desktop build:brand-assets`。[构建脚本](../../apps/desktop/scripts/build-brand-assets.mjs)派生 512 像素的共享图、Desktop 运行时图、macOS 圆角留白图、默认包图标 `icon.icns` 与 iOS 图标。派生文件也提交；在干净的源上重跑构建，不应改变任何已提交文件，也不应产生新文件。
3. 在品牌清单里登记一条 `app-icon`。

## 一个境的大图

1. 一份母版出两种裁切：启动用 16:9，Launcher 背景与 Settings 概览用宽幅约 3:1，文件按[品牌源目录说明](../../packages/client-ui/brand/README.md)的规则命名。龙放在右侧三分之一，左侧留给文字与操作，深浅主题下都要和界面覆盖渐变协调。
2. 编码成 AVIF（`sips -s format avif -s formatOptions 85 源图 --out heroes/<境>-launch.avif`）。在相同显示倍率下和原图做 1:1 对比，确认没有可见损失。
3. 在 [`brand-hero.ts`](../../apps/desktop/src/renderer/src/lib/brand-hero.ts) 的大图表里为这个境加一项。它是唯一列出大图文件的地方，启动、Launcher 与 Settings 概览都经同一个 `resolveBrandHero` 取图，表的类型要求原境一项必须存在。
4. 在品牌清单里登记两条 `hero`，填写 `surface`。
5. 在工作台的「品牌」视图里核对：这个境的三张大图卡不再标「借原境」，题款写的是这个境。

## 工坊插画

插画放进 `illustrations/` 的对应目录，按包路径从使用它的组件导入，并在清单里以 `commons` 登记。工坊插画不随 App 图标切换，也不加题款。

## 核对

- [清单测试](../../packages/client-ui/test/brand-manifest.test.ts)保证清单与目录双向一致。
- `pnpm icons:dev` 打开品牌与图标工作台，默认进入「品牌」视图，开发模式下素材一改就刷新。`pnpm icons:build` 构建静态快照，图片以文件形式放在页面旁边。快照用 amux Capsule 常驻发布，之后对同一个页面身份更新。
- 视觉改动按[独立 Agent 看图评审](agent-visual-e2e-review.md)实际采图评审。
- 生成图的提示词、候选稿与评审过程属于过程资料，留在本机，不提交，边界见[过程资料规则](../process-directories.md)。
