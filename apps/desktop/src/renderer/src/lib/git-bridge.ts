import type { AgentMuxPreloadApi } from '../../../shared/contracts'

/**
 * 「Git 桥在不在」这一个判断，以及它缺席时对用户说的那一句话。
 *
 * 为什么要有这一层：Git 刻意只活在 preload 面上（见 contracts.ts 里 `AgentMuxPreloadApi.git` 的注释：
 * web preview 没有有意义的 git mock），所以渲染层拿桥的唯一途径是 `window.agentmux?.git`——而这一步
 * 此前被独立手抄了四次，三种写法：
 *   - `store.ts` 与 `useGitStatus.ts`：`?.` 加判缺席，各自**又抄了一遍**同一句 'Git is unavailable…'。
 *   - `ChangesPanel.tsx`：`window.agentmux!.git`，非空断言。桥缺席时点 Stage 抛裸 TypeError，而它
 *     旁边那两处对同一个桥好好地报了「不可用」。同一个前提被判出了两种结论，这正是手抄的代价。
 *
 * 判据落在**取值关系**上：每个 git 调用点的桥都必须来自这里，而不是各自再摸一次 `window`。所以这
 * 个函数返回的是一个带标签的联合，而不是 `Bridge | null`——`null` 会让调用方各自去编缺席时的说法，
 * 那就把刚收敛掉的东西又散开了。
 */
export type GitBridge = AgentMuxPreloadApi['git']

/** 桥缺席时给用户的那一句。只在这里出现一次。 */
export const GIT_UNAVAILABLE = 'Git is unavailable in this build.'

export type GitBridgeLookup =
  | { available: true; bridge: GitBridge }
  | { available: false; reason: string }

/**
 * 取 Git 桥。缺席不是异常——web preview 是一个受支持的宿主，那里根本没有 git。
 *
 * 刻意不接受参数、也不缓存：`window.agentmux` 由 preload 在文档加载时装好，之后不变；缓存只会让
 * 测试更难替换它，换不来任何东西。
 */
export function gitBridge(): GitBridgeLookup {
  const bridge = window.agentmux?.git
  if (!bridge) return { available: false, reason: GIT_UNAVAILABLE }
  return { available: true, bridge }
}
