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
 * 于是 launcher 挂在绑定 A 的 Tab 上、而活动 Workspace 是 B 时（切一下侧栏即可，Tab 不动）：
 * 标题写「Start in A」，点 Launch / Terminal / Browser 都落在 A，点 Note **建到 B**。全程零报错、
 * 界面一切正常，只是笔记出现在另一个项目里——名字只是当天日期，那边有同名文件的概率还很高。
 *
 * 「今天恰好一致」不构成可以各判一次的理由：这一族缺陷本仓已经中过两轮（createPath 与 openFile
 * 各读一次活动 Workspace）。判定必须只有一处，让它不可能分岔。
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
