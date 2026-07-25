# wiki-first-scratch：Scratch 作为多 Agent 协作 Wiki

## 问题

Scratch 是“没选项目、就想直接干件事”的地方，背后是一个真实的本地工作区
`~/.agentmux/scratch`。

它不能只是一块空目录，也不能只提供“哪些 Agent 正在运行”的进程监控视角。用户在 Scratch
里真正要组织的是一件件事情：目标是什么、有哪些上下文、谁在参与、产出放在哪里。Scratch
因此采用 wiki-first 模型，用文件系统作为多 Agent 共享上下文和协作产出的底座。

## 产品合同

- Scratch 根目录下每一个符合命名合同的 `topic--*` 目录本身就是一个 Topic。Topic 不依赖某个
  View 当前存在、打开或激活。
- Workbench View 可以绑定一个 Topic。`topicId` 只保存稳定的导航关系；移动 Tab 不会改变绑定，
  关闭 View 也不会删除或隐藏 Topic。
- 同一 View 内分屏启动的新 Agent 加入同一个 Topic。
- 点击 `Create new Topic`，或在一个未绑定 Topic 的新 View 中启动 Agent，会创建独立 View
  身份和独立 Topic。
- 在没有 Topic 的 View 中启动 Agent，会先自动创建 Topic，再启动 Agent。
- Topics 面板始终从 Scratch 文件系统列出全部 Topic。没有 Topic 时才显示说明和
  `Create new Topic` 主按钮；已有 Topic 时，标题收敛为带 `+` 的单行工具栏。当前 View 的绑定
  只用于标记 `Current`，不得过滤列表。
- 点击已有 Topic 时，若绑定它的 View 仍打开则聚焦该 View；否则创建一个绑定它的 Launcher
  View。这个操作不得把当前 Terminal View 隐式改绑到其他 Topic。
- Topic 使用扁平的两行条目显示标题、摘要、协作者数量和 `Current` 状态。条目点击打开 Topic；
  右侧提供紧凑的改名和目录定位图标，不在列表中展开 `Open topic.md` 操作。改名只修改
  `topic.md` 的一级标题，Enter 提交、Escape 取消。
- 文件树展示 Scratch 根目录下真实存在的 Topic 目录，不维护一份只存在于 UI 的 Topic 列表。

## 文件系统模型

每个 Topic 都是 Scratch 根目录下的一个稳定目录：

```text
scratch/topic--<view-kind>--<stable-id>/
├── topic.md
├── outcome/
├── refs/
└── .agents/
    └── <provider>.<agent-session-id>.identity.md
```

- `topic.md` 记录这件事的共享目标、上下文和耐久决策。
- `outcome/` 存放交付物。
- `refs/` 存放引用材料。
- `.agents/` 存放参与者的短 memory；每个 Agent 一份文件，避免身份写入互相覆盖。
- 创建时目录名来自 View 的稳定 ID；目录创建后就是独立存在的 Topic 身份，不以原 View 是否
  仍存在为条件。Topic 的人类可读标题写在 `topic.md`，目录名不承担标题职责。
- Topic 改名不得移动或重命名 `topic--*` 目录，也不得改变 `topicId`、Agent cwd、View 绑定或
  resume 路径。Explorer 不向这些顶层稳定目录暴露通用文件系统 Rename；普通文件和目录保持原行为。
- Topic 的内容和协作者身份以文件系统为准。Workbench 只持久化 View 到 Topic 的导航绑定，
  不建立 Topic Registry 或第二份内容状态。

创建操作是幂等的：已有 Topic 不覆盖 `topic.md`，只补齐缺少的结构。普通项目不能调用
Scratch Topic 文件操作。

## Agent 启动与加入

Scratch Agent 启动前，主进程按以下顺序完成准备：

1. 确保 View 对应的 Topic 目录及基础文件存在。
2. 写入当前 Agent 的 `.agents/<provider>.<agent-session-id>.identity.md`。
3. 把 Agent 的 cwd 设置为 Topic 目录。
4. 注入 `AGENTMUX_WIKI_DIR`。
5. 在开场上下文中说明 `topic.md`、`outcome/`、`refs/`、`.agents/` 的用法，再接用户任务。

没有用户任务时，Agent 明确等待用户，不把初始化说明误当成待执行任务。启动失败时，只清理本次
新写入的身份文件，已经存在的 Topic 和其他协作者文件不受影响。

身份文件是共享短 memory，不是运行时状态：

- Agent 通过读取 `.agents/` 发现其他协作者。
- Agent 在角色、当前重点或耐久交接上下文变化时更新自己的身份文件。
- 身份文件不复制 PTY 输出、Replay、Gap、进程存活或 Agent status。

Provider-native resume 继续使用原 Topic cwd，并重新注入 `AGENTMUX_WIKI_DIR`。Topic 目录中的
耐久上下文不依赖某个 Run 是否仍然存活。

## Workbench 与恢复

`WorkbenchTab.topicId` 保存 View 到 Topic 的稳定绑定。它是展示和导航身份，不是 Topic 内容的
第二真相源。

- Topic 列表直接枚举文件系统，不从 Workbench 布局反推。没有任何 View 绑定时，已有 Topic
  仍必须出现在 Wiki 中。
- 带 Agent Session 的 Topic View 随 Workbench 布局持久化。
- 尚未启动 Agent 的空 Topic View 也会保留其 Launcher，因此点击创建后重启不会丢失入口。
- 打开一个没有现存 View 的 Topic 时，只补一个绑定该 Topic 的 Launcher View，不认领当前
  Terminal View。
- 若本地 Workbench 状态缺失，Agent Session 的 Topic cwd 可以反推出 Topic 身份并重新归入
  Scratch。
- Scratch Topic 子目录中的 Session 在 UI 中仍属于 Scratch；普通项目继续使用精确工作区路径
  归属，不把任意子目录 Session 吸收到项目里。
- 文件 Tab 继承当前 View 的 Topic 绑定，因此打开 `topic.md` 后 Topics 面板不会丢失上下文。
- 内置 Editor 保存 Topic 的 `topic.md` 后立即使 Topics 快照失效并重读；不为此引入文件轮询、
  watcher 或第二份 Topic 状态。

## 文件视图

Scratch 与普通项目复用同一组工作区工具槽，不新增第二套导航分类：

- 普通项目的内容槽是 `Files + Branches`。
- Scratch 的同一内容槽显示为 `Files + Topics`。
- 上半部分是 Topic 文件树；下半部分是列出全部文件系统 Topic 的 Wiki 面板，并标记当前 View
  绑定的 Topic。
- Topics 是主视角，文件树默认占较小比例。
- Agents 工具保持独立，只负责查看可重新打开的 Agent Session，不承担 Topic 组织职责。

## 运行时边界

Topic、身份文件、Provider、AgentSession、prompt 语义和 View 绑定由 AgentMux 持有。ctxmux 仍只
持有 PTY、进程、Run lifecycle、ordered bytes、Replay、Gap、Attachment 与权威 Runtime 事实。
`.agents/` 不得演变成第二份 Runtime 状态，也不得用文件轮询替代 ctxmux 或 AgentMux 的权威事件。

## 不做

- 不改变 Scratch 根目录的位置和配置方式。
- 不为 Topic 新增数据库、Registry 或后台进程。
- 不把 wiki 目录结构强加给普通 Git 工作区。
- 不让文件树的选择状态隐式改变 View 到 Topic 的绑定。
- 不把身份文件当作在线状态、锁、消息队列或并发写入协调器。
- 不用兼容层保留旧的静态 Topics 面板或根目录 cwd 行为。

## 验收合同

- Scratch 空状态可直接创建真实 Topic，文件树和 Wiki 面板都能看到对应目录。
- 即使当前 View 没有绑定 Topic，Wiki 面板仍列出 Scratch 根目录中的全部 Topic。
- Wiki 有 Topic 时使用单行标题和两行扁平条目；说明文字和主创建按钮只属于真正的空状态。
- Topic 条目提供打开、语义改名和在内置 Explorer 中展开、选中其目录，不额外展开打开
  `topic.md` 的按钮；目录动作不得调用 Finder 或其他系统文件管理器。
- 改名后 Topic 目录、`topicId`、Agent cwd、View 绑定和正文保持不变，标题立即刷新；空、多行和
  过长标题失败关闭。
- 打开已有 Topic 会聚焦其现存 View 或创建一个新的绑定 Launcher，不改绑当前 Terminal View。
- Scratch Agent 启动会创建完整脚手架和自己的身份文件，并直接在 Topic 目录运行。
- 同一 View 内的分屏 Agent 使用同一 Topic；新 Topic 使用不同 View 和目录。
- Topic 标题、摘要和协作者从文件系统读取。
- Workbench 重启后恢复 View 与 Topic 的绑定。
- 普通项目的工作区归属、Agent 启动、文件视图与 Branches 行为不变。
