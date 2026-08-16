# 左栏密度、running/working 可分，与 Message Tools 的身份

Date: 2026-09-19
Scope: 用户本轮在 `f-2688fn733`（认得出是哪一格、哪个 Agent 在干什么）Closure 内提出的三件事。
Status: approved for implementation.

## 1. 用户要的是什么（逐字）

本轮三句原话：

1. 「**ctxmux 的最新版本接入下**」
2. 「**左侧项目菜单的缩进有点多, 图标有点大, 每个项的高度有点高了, 可以更加紧凑些, 或者在顶层的
   projects 上的加号旁边增加一个组件, 调整紧凑程度**」
3. 「**running 和 working 不光提示文字不同, 图标动画也应该区分**」

以及上一轮同 Closure 的一句，本轮一并落地：

4. 「**我感觉 MessageTools 该品牌升级了, 实际在用的 Agent 头像也应该显示出来, 而不是只在右边有一个
   名字. 同时右边的项目名字, 也应该改成 tab 名 / region 内的 session 名, 要不然没啥意义**」

## 2. 查证结果：第 1 条不需要做

Vendored 的 ctxmux 已经是最新。判据（2026-09-19 实跑）：

| 问的是什么 | 命令 | 结果 |
| --- | --- | --- |
| vendored 绑的是哪个 commit | `packages/core/vendor/ctxmux/darwin-arm64/manifest.json` 的 `source.commit` | `c35f6217109c358ad730b0c8a7e879c3257a2ab7`，protocol 17 |
| 上游本地 main 在哪 | `git -C ~/proj/priv/bagaking/ctxmux log --oneline -1` | 同一个 `c35f621` |
| 上游领先 vendored 几个 | `git rev-list --count c35f621..HEAD` | **0** |
| vendored 领先上游几个 | `git rev-list --count HEAD..c35f621` | **0** |
| 本地 main 落后 origin 几个 | `git rev-list --count HEAD..@{u}` | **0** |

上一轮的 `1667151b feat(core): vendor ctxmux protocol 17 and read past the protocol in version
contracts` 就是这次接入。**没有可升的版本**，动手只会换出一个内容相同的二进制，而
`manifest.json` 的 sha 会挡住换二进制（本仓既有形态：vendored ctxmuxd 换不得）。

上游 checkout 在 `~/proj/priv/bagaking/ctxmux`（不是 `bagakit`）。它有三个带活跃工作的 worktree
（`feat/f-22mczss86`、`feat/rename-spec-initial-size`、`perf/ratchet-r2`），本轮不碰。

## 3. 左栏密度：三个旋钮，一个档

### 3.1 实测现状

`apps/desktop/src/renderer/src/styles/chrome.css`：

| 旋钮 | 现值 | 位置 |
| --- | --- | --- |
| 每层缩进 | `var(--sp-6)` = **16px/层** | `:130` `padding-left: calc(var(--sp-4) + var(--rail-depth) * var(--sp-6))` |
| 行图标框 | **20px**（内部 `img` 16px） | `:139`，`img` 在 `:334` |
| 行高 | `min-height: 28px` | `:130` |

用户三句抱怨与这三个数字一一对应，不是模糊的"太松"。

### 3.2 同一个缩进公式出现在两处

`chrome.css:131` 的 `.project-rail-row-shell` **重复了** `:130` 的缩进公式。这是本仓既有形态
「两个写入点要收成一处投影」的现成实例：只改一处会让带折叠箭头的行与不带的行左缘错开。密度档
必须让两处同时变，所以档位应当是**容器上一个属性重定义的 CSS 自定义属性**，而不是把三个数字
穿过 React props——后者允许三个旋钮各自漂移，正是设计约束禁止的"半档"。

### 3.3 控件的位置与形态

用户指定了位置：Projects 标题行的加号旁（`WorkspaceSidebar.tsx:304-307`）。这个位置的含义是
**看着树调**——所以它不进设置页。档位数保持极少（默认 + 更紧），不做无级滑块：滑块要求用户自己
找一个好值，而这件事只有两三个好值。

密度是 durable 的（重启后仍是用户选的那一档），走既有可选 `AppConfig` 字段的形状（`appLinkSchemes`
/ `notifications` 那条路：`shared/contracts.ts` 类型 → `main/config-store.ts` 的 `.strict()` schema
→ 默认）。缺席即默认档，**不回写**（同 `appLinkSchemes` 的理由：空与缺席同义）。

⚠️ 本仓既有形态「声明了却静默不做的能力」：一个没有消费者的配置字段是免检的谎言。验收必须证明
这个字段真被读到、并真改变了渲染。

### 3.4 密度是看法，不是数据

切档只改视觉三项，**不改树结构、归属、选中项或滚动位置**。

## 4. running / working：现状是"两个都没动"，不是"动得一样"

### 4.1 用户的措辞与实际缺陷差一格

用户说「图标动画也应该区分」，读起来像"两个都有动画但长得像"。实测不是：

- 图标**本来就不同**——`semantic-icons/index.tsx:52-53` 是 `running: Radio` / `working: Activity`。
- 会话状态那条路径上**一个动画都没有**。全仓只有两处动画，都不在这条路径上：
  - `workflow.css:81` `.wf-spin`，挂在 `semantic-icons/index.tsx:83`，但只给 **workflow** 变体的
    `running`。那是另一个轴（workflow run 状态），不是 agent session 状态。
  - `activity.css:311` `activity-working-pulse`，只挂在 `.activity-working__dots i`——一个点阵指示
    器，不是状态字形。

所以要补的是"给 working 加动势"，不是"把两个动画改得不一样"。

### 4.2 两个轴共用一个词

`semantic-icons/index.tsx:82` 把 `running` 重映射成 `'workflow'`（仅 workflow 变体）。
workflow-`running` 与 session-`running` 是两件不同的事实，碰巧共用一个单词。改动不得让两个轴
互相污染。

### 4.3 渲染点可能不止一处

我只 grep 到 `ProjectActivity.tsx:209`，但那只是一种拼法（`SemanticIcon name={...status`）。
状态栏、tab strip、rail 通知胶囊、agents 菜单都可能各有一处。本仓既有形态「两个写入点要收成
一处投影」：只在一处加动画、另一处静默保持旧行为，症状会是"有时区分得出有时区分不出"。
**必须先枚举全部渲染点**，再决定是修共享组件（首选——一处守卫覆盖所有调用方）还是逐点修。

### 4.4 这不是新需求

`docs/design/agentmux-surface-density.md` 的 `### Agents、队列与语义 token 密度` 早已写着
「running 使用稳定静态 glyph，working 使用带节奏的动态 glyph；两者不能只靠颜色区分」。
本轮新增的只是"哪一个是哪一个"的消歧（写进 interaction 文档的 `### Project Rail、通知与 Topic
presence`）：`running` = 进程活着但未在产出 → 静态；`working` = 正在产出 → 带节奏。

reduced-motion 下动势退化为静态，但**字形差异必须保留**——否则无障碍档位下这条约束整体失效。

## 5. Message Tools 的身份与右上角那行字

### 5.1 `f-2688fn733` 的 goal 状态已过期

那份 goal 声称 (1)(3) 两条链"尚未入库"，并给了问 git 的判据。**本轮四条判据全部在 HEAD 命中**：

```
composer__region          HEAD:apps/desktop/src/renderer/src/components/AgentComposer.tsx
resource-usage__activity  HEAD:apps/desktop/src/renderer/src/components/ResourceUsagePanel.tsx
AgentTreePanel            HEAD:apps/desktop/src/renderer/src/components/AgentRoster.tsx
projectActivityRow        HEAD:apps/desktop/src/renderer/src/components/ProjectActivity.tsx
```

即 goal 自己预言的那种失效已经发生（tracker 状态不是真相）。所以本轮**不是新建水印挂载点**，
而是改已入库的那一处的**内容与视觉**。

### 5.2 右上角现在显示什么

`AgentComposer.tsx:231` 渲染 `<span className="composer__region" title={regionName}>`，样式在
`composer.css:32`（绝对定位、`opacity: .55`、`--fs-micro`、`pointer-events: none`）。
用户说它显示项目名"没啥意义"，要改成 tab 名 / region 内的 session 名。

### 5.3 一条自己造出来的语义冲突，必须在本轮解掉

`composer.css:169` 有一条：

```css
.composer:has(.composer-tools[data-mode='collapsed']) .composer__region { display: none; }
```

这条是我在修一行态重叠时加的，当时的理由是"这行字没意义，一行态下藏掉最省事"。
一旦 §5.2 让它变成有意义的 session 名，**这个理由就不成立了**——一个本该有用的 session 名，
在一行态下仍被藏着。这不是 git 冲突（两处改动文件不同），是语义冲突：删掉这条规则、还是让
一行态下换一种更省地方的表达，必须在本轮明确决定，不允许两边各自为真。

## 6. 本轮不做

- ctxmux 升级（§2：已是最新，动手是空转）。
- 无级密度滑块（§3.3）。
- 把 workflow 与 session 两个状态轴合并（§4.2）。
