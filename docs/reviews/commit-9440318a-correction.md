# 更正：9440318a 的 commit message 有两处失真

审计（提交后异步）对照 diff 逐条核实，发现 message 与代码不符两处。代码本身没问题——
5 个文件、作用域干净、测试真实驱动 store。错的是**对代码的描述**。留此记录因为
commit message 已入历史无法重写，而一条描述错场景的记录会把后来的人引向不存在的代码。

## 一、场景说反了：这是会话内启动竞态，不是跨重启对账

message 开头写「启动时若某个 Agent Session 的 run 已经不在 daemon 里（进程被外部杀掉、
daemon 重启过）……用户昨天开的 agent 今天打开 app 就不见了」。

diff 里没有任何一行碰启动对账。真实改动在 `store.ts:2467-2487` 的 `open.agent` 控制路径：
Agent 起来了、但承载它的 Region 在启动过程中被关掉或 id 被回收。而且这份状态是
**显式 ephemeral、从不持久化**的（`store.ts:236-242`：「a launch race is a within-session
fact」）。一份不落盘的会话内列表**不可能**支撑「昨天开的今天不见了」那个跨重启故事——
描述与设计直接矛盾。

代码注释、组件 docstring、测试 docstring 三处都正确写着启动竞态；只有 commit message 的
散文跑偏了。

## 二、「后续计划」里那条自认的盲点，是假的

message 写：「本次的 gate 是瞎的：实测把 App.tsx 里的 `<DisplacedAgentNotice />` 整行删掉，
3 个用例仍然全绿」。

同一个提交里就有一条测试专门守这件事：`displaced-agent-notice.test.tsx:178`
「App 主壳里挂出了错位告示——删掉 App.tsx 那行渲染，这条红」，它挂真的 `<App/>`，断言
`main.main-shell` 里能查到 `.displaced-agent-notice`。

复跑变异确认（只删 `App.tsx:318` 那一行渲染，保留 import，保证只改一件事）：

    Test Files  1 failed (1)
    Tests  1 failed | 2 passed (3)
    ❯ displaced-agent-notice.test.tsx:200 错位告示没有挂在窗口锚点上

即：gate 真的咬。原 message 那句自白是过时的（写于该测试补上之前），提交时已不成立。
方向是安全的——低报了自己的覆盖，不是高报——但「特意规避 / 后续计划」两节正是审计要核的，
失真就得更正。

## 真实存在的盲点（比那条假的小）

- `store.ts:2485` 的 `void get().resyncTimeline(timelineGapSessionId)` 无人守，删掉全绿。
- 没有任何一条用例同时跑「真 store 填充 + 真 App 渲染」：用例 1/2 孤立挂组件，用例 3 手写
  state 再挂 App。`selectDisplacedAgentNotices` 是 `(sessions, tabs, ids)` 的纯函数、两半各有
  真实路径覆盖，所以影响有限，但这个接缝目前只是理论可catch。

## 方法教训

自白式的 commit message 不会因为「看起来诚实」就免检。我写下那句盲点自白时没有重跑变异——
而那条测试是我自己在同一轮里补的。**宣称覆盖要跑，宣称没覆盖同样要跑。**
