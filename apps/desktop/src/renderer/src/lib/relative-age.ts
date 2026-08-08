/**
 * 「这个时间戳有多久了」的唯一判档处。
 *
 * ─── 为什么这个文件必须存在 ───
 *
 * 这套阶梯原本在两个组件里各写一份（`WorkspaceBoard` 的 `formatAge`、`SurfaceToolDock` 的
 * `formatAgentAge`），两份都读同一个 `session.updatedAt` 并渲染进 `<time>`。两份的**档位判定逐字
 * 相同**——都是 1 分钟以下算 now、60 分钟以下报分钟、24 小时以下报小时、再往上报天——所以今天两个
 * 面对同一个会话给出同一档。
 *
 * 这正是这类缺陷最危险的形态：**它现在是对的**。任何一侧把「几分钟以后改报小时」这个界挪一下
 * （产品上完全合理的要求），另一侧不会红、不会报错、也没有人会想起去改，于是同一个 agent 在看板上
 * 写「90m」而在工具坞里写「1h」。本仓这一族已经反复出现：同一个决定写两遍，必然漂移。
 *
 * ─── 什么是这里的决定，什么不是 ───
 *
 * **是**这里的决定：档位边界（1 分钟 / 60 分钟 / 24 小时）与每一档的取整方式。这些是「这个会话有多旧」
 * 的答案，跨面必须一致。
 *
 * **不是**这里的决定：后缀。看板卡片宽，写 `12m ago` 读起来是完整的句子；工具坞是窄面板，密度合同
 * （`docs/design/agentmux-surface-density.md` 的密度预算）把时间戳压在 `--fs-micro` 一档，那里 `12m`
 * 才放得下。所以后缀是**调用方按自己的密度选**的，不是漂移——把它也收进来会让窄面被迫变宽。
 * `now` 一档永远不带后缀：`now ago` 不是句子。
 *
 * ─── 未来的时间戳为什么不需要单独夹一次 ───
 *
 * 宿主与 daemon 的钟不同步时 `elapsedMs` 可以是负的，而报 `-3m ago` 比报 `now` 糟得多。这个函数最初
 * 写了一句 `Math.max(0, elapsedMs)`，但它**不可能改变任何结果**：负数除以 60_000 再向下取整仍是负数，
 * 于是照旧落进下面那道 `minutes < 1`。删掉它之后测试全绿——这不是判据缺了一条，是那句本来就是死的。
 * 负数读成 `now` 这件事由 `minutes < 1` 独自承重，`relativeAgeTier` 的负值用例钉的就是它。
 *
 * ─── 取 elapsed 而不取 timestamp ───
 *
 * 入参是**已经算好的毫秒差**，不是时间戳。这样这个函数是纯的：判据不用替换时钟就能钉住每一个档位
 * 边界。本仓有一条教训是「判别器可能在别的环境缺席」——让测试自己给出 elapsed，边界就不依赖跑测试
 * 时恰好是几点。
 */

/** 一条相对年龄落在哪一档。`now` 没有数值——它就是「不值得报数」这个判断本身。 */
export type RelativeAgeTier =
  | { unit: 'now' }
  | { unit: 'minute'; value: number }
  | { unit: 'hour'; value: number }
  | { unit: 'day'; value: number }

const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

/**
 * 把毫秒差判成一档。
 *
 * @param elapsedMs 现在减去那个时间戳。负数（时间戳在未来，例如宿主与 daemon 的钟不同步）会落进
 *                  `minutes < 1` 读成 `now`——报一个负的分钟数比报 now 更糟。见文件头：这里**不**
 *                  额外夹一次 `Math.max(0, …)`，那句改不了任何结果。
 */
export function relativeAgeTier(elapsedMs: number): RelativeAgeTier {
  const minutes = Math.floor(elapsedMs / MS_PER_MINUTE)
  if (minutes < 1) return { unit: 'now' }
  if (minutes < MINUTES_PER_HOUR) return { unit: 'minute', value: minutes }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return { unit: 'hour', value: hours }
  return { unit: 'day', value: Math.floor(hours / HOURS_PER_DAY) }
}

const TIER_LETTERS: Record<Exclude<RelativeAgeTier['unit'], 'now'>, string> = {
  minute: 'm',
  hour: 'h',
  day: 'd'
}

/**
 * 把毫秒差渲染成给人看的一小段文字。
 *
 * @param elapsedMs 现在减去那个时间戳
 * @param suffix    数值档要不要带尾巴（看板用 `' ago'`，窄面留空）。`now` 一档永不加。
 */
export function formatRelativeAge(elapsedMs: number, suffix = ''): string {
  const tier = relativeAgeTier(elapsedMs)
  if (tier.unit === 'now') return 'now'
  return `${tier.value}${TIER_LETTERS[tier.unit]}${suffix}`
}
