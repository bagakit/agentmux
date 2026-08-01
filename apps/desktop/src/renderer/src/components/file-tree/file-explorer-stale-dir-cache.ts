import type { DirCache } from './file-explorer-types'

export function collectStaleDirCachePaths(
  cache: Record<string, DirCache>,
  rootPath: string,
  expanded: ReadonlySet<string>
): string[] {
  return Object.keys(cache).filter((dirPath) => dirPath !== rootPath && !expanded.has(dirPath))
}

export type ExpandedDirLoadDecision = 'skip' | 'load' | 'reload'

export function decideExpandedDirLoad(
  cached: DirCache | undefined,
  stale: boolean
): ExpandedDirLoadDecision {
  if (cached?.loading) return 'skip'
  // 读失败留下的空 children 不能算「已加载」：否则再次展开时这里判 'skip'，那个目录就永久停在
  // 失败态，用户除了切 Workspace 之外没有任何重试路径。
  if (cached?.error) return 'load'
  if (!cached?.children.length) return 'load'
  return stale ? 'reload' : 'skip'
}

/**
 * 一个已展开目录在树里该显示成什么。
 *
 * 抽成纯函数是因为这个仓库的 desktop 测试没有真挂载（只有 `renderToStaticMarkup`，它不跑
 * effect），组件里的分支无法被行为断言质询。判定住在这里，则「读失败被显示成空文件夹」这件事
 * 有一处可被变异打红的取值。
 */
export type ExpandedDirPresentation = 'loading' | 'failed' | 'empty' | 'populated'

export function presentExpandedDir(cached: DirCache | undefined): ExpandedDirPresentation {
  // 没有 cache 项与「正在读」在用户看到的东西上是同一件事：都还不知道里面有什么。
  if (!cached || cached.loading) return 'loading'
  // 失败优先于「空」。刷新失败时 children 会保留上一次读到的内容（见 useWorkspaceFileTree 的
  // catch），所以这里不能按 children 是否为空来分派——那样一个「有内容但刷新失败」的目录会被
  // 显示成完全正常。
  if (cached.error) return 'failed'
  return cached.children.length ? 'populated' : 'empty'
}
