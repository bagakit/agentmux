/**
 * 「这个 launcher 面向哪个 Workspace」——显示与全部启动动作共用的**唯一**一次判定。
 *
 * 规则本身一句话：launcher 所在 Tab 绑着哪个 Workspace 就用那个，没有绑定（空分组占位）才退到当前
 * 活动 Workspace。之所以要抽出来，是因为它此前被手抄了六遍，而其中一遍抄漏了：
 *
 *   - `launchAgent` / `launchTerminal` / `promoteWarmTerminal` / `createBrowser`：
 *     `launcherTab?.workspaceId ?? state.activeWorkspaceId`
 *   - `NewTabSurface`（决定卡片上写「Start in ⟨谁⟩」）：`tabWorkspaceId ?? activeWorkspaceId`
 *   - `createNote`：**只有** `get().activeWorkspaceId`
 *
 * 分岔的后果：launcher 挂在绑定 A 的 Tab 上、而活动 Workspace 是 B 时，标题写「Start in A」，
 * 点 Launch / Terminal / Browser 都落在 A，而点 Note 会建到 B——全程零报错，笔记出现在另一个项目
 * 里，名字只是当天日期，那边有同名文件的概率还很高。
 *
 * 但要说准：**这个后果今天还走不到**。非活动 Workspace 的整块 workbench 带 `inert`
 * （App.tsx:247 `inert={!visible}`，visible = `workbenchVisible && candidate.id === activeWorkspaceId`），
 * 所以「切侧栏到 B、再回头点 A 那个 launcher 的 Note」这一步点不动；按钮可点时 activeWorkspaceId
 * 必然就是 A，旧写法读到的也是 A。故这次收敛是**行为保持 + 防御**，不是修一个当天能触发的 bug。
 *
 * 之所以仍然值得先做：可达性是 `inert` 这一个前提买来的，而 #265 的浮动工作区恰好要拆掉它——浮层
 * 里的 launcher 悬在主区之上，它绑的 Workspace 与背后活动的那个本就可以不同，那时上面那段就从
 * 「不可达」变成常态。把「今天恰好一致」留在原地等那一天，就是本仓 expired-reason 那一族：刻意不
 * 处理的理由读起来像已决之事，前提变了却没人回头看。
 *
 * 「今天恰好一致」也不构成可以各判一次的理由：这一族本仓已经中过两轮（createPath 与 openFile 各读
 * 一次活动 Workspace，那两次是真的漂了）。判定只有一处，才让它不可能分岔。
 *
 * 两个字段都是**必填**的，这是刻意的：原缺陷的形状正是「整条 launcher 那一侧根本没写」，而漏掉一个
 * 必填字段是编译错误。若把 launcher 那侧做成可选，第七个动作可以什么都不传、拿到一个看起来合理的
 * 结果，于是同一个 bug 原地重来一次而 tsc 全程沉默。
 *
 * 这里刻意**不**顺带解析 layout / targetTab / regionId：那几步各动作确实不同（有的要 topic 继承、
 * 有的要先停 PTY），把它们一起塞进来会造出一个每个调用方只用一半的返回值。这个函数只回答
 * 「哪个 Workspace」这一个问题。
 */
export function resolveLauncherWorkspaceId(input: {
  /**
   * launcher 所在 Tab 绑定的 Workspace。store 侧传 `launcherTab?.workspaceId`，组件侧传它那个
   * selector 的取值；空分组占位两边都是 undefined。
   *
   * 刻意不收整个 Tab：组件侧只订阅了这一个字段，改成订阅整个 Tab 对象会让它随任何一次 Tab 变更
   * 重渲染（zustand 按引用比较），为了「参数好看点」买一次性能回归不值得。
   */
  launcherTabWorkspaceId: string | undefined
  activeWorkspaceId: string | null
}): string | null {
  return input.launcherTabWorkspaceId ?? input.activeWorkspaceId
}
