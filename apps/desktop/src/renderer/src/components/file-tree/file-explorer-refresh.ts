/**
 * 「刷新 Explorer」这一个动作的定义：重扫目录结构 **加** 重取 git 状态。
 *
 * 分成两件事是 #750 的成因。树的结构由 `useWorkspaceFileTree.refreshTree` 重扫，git 着色由
 * `useGitStatus.refresh` 重取，而后者此前在 FileExplorer 里根本没有被取出来——`useGitStatus`
 * 只在挂载时的 effect 里取一次数，此后整个组件生命周期内那份 porcelain 再不更新。于是 agent
 * 在盘上改了文件、树里新文件都出现了，颜色却停在打开面板那一刻的快照上，且**没有任何入口**能把它
 * 推回同步：五个刷新触发点（revision 变化、窗口重获焦点、重绑路径、头部刷新按钮、读失败重试）
 * 一律只调 `refreshTree`。
 *
 * 所以这里不是给树的刷新“顺手加一句 git”，而是把「刷新」收成一个概念：调用方要么两个都刷，
 * 要么一个都不刷，没有第三种。这个仓里刷新计数器被手抄五份的事故（#271）就是同一形状——分散的
 * 调用点各自决定刷什么，漏掉的那一份完全静默。
 *
 * 两个取值口**并发**发起而不是串起来：它们打的是两条互不相干的 IPC（files:readDirectory 与
 * git:status），串起来只会让远端 workspace 上的一次刷新等两个往返。并发也顺带钉住一条语义——
 * 结构重扫失败（`refreshTree` 返回 false，比如 workspace 作用域已经换过）**不该**跳过 git 那半边，
 * 因为两者的失效条件不同。
 *
 * 两个来源都在自己内部吞掉异常并以 boolean 汇报成败，所以这里刻意用 `Promise.all` 而不是
 * `allSettled`：哪天其中一个开始真的抛，`await` 的调用点（rebindWorkspacePath 的 try/catch）会如实
 * 报出来，`void` 的调用点会留下一条未处理拒绝——都比被 allSettled 静默咽掉好。
 */
export async function refreshFileExplorer(sources: {
  refreshTree: () => Promise<boolean>
  refreshGitStatus: () => Promise<boolean>
}): Promise<void> {
  await Promise.all([sources.refreshTree(), sources.refreshGitStatus()])
}
