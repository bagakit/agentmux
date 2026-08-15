/**
 * 「这一步到底干了什么」——折叠态下的行标题。
 *
 * 折叠起来的一行今天只有一个裸工具名：三行 `Bash`、两行 `Read`，要知道跑的是哪条命令、读的是
 * 哪个文件，必须逐个展开成原始 JSON。可这恰恰是折叠要省掉的那一步——折叠的前提是**不展开也
 * 认得出**，否则它只是把信息藏起来。
 *
 * 因此按工具种类取那个最具识别性的字段：读文件取路径，跑命令取命令本身。**不做正则猜测**——
 * 猜错的摘要比没有摘要更坏：它看起来是一个已核实的事实，实际是从一段 JSON 里蒙出来的。取不到
 * 就如实只显示工具名，不显示空括号之类的空壳。
 *
 * 判定写成纯函数：本仓库测试用 `renderToStaticMarkup`，effect 不跑，写在组件里的分支没有断言
 * 够得着。
 */

/** 摘要的长度上界。超出即截断——一条长命令铺满整行会把时间偏移挤出可视区。 */
export const MAX_STEP_SUMMARY_LENGTH = 48

/**
 * 截断要保留哪一头，由**字段名**决定，因为字段名正是「这是不是一条路径」的声明。
 *
 * 路径的识别位在**尾部**。而工具收到的路径是绝对路径（Read/Edit/Write 的入参按约定就是绝对路径，
 * 见 hook-normalizer 原样透传 `tool_input`），于是同一个仓库里每条路径的**前缀完全一样**——保留头部
 * 等于把 48 格全花在 `/Users/<user>/proj/.../<repo>/` 上，两个不同的文件截出来一模一样。实测本仓：
 *   `Edit /Users/…/lib/session-recency.ts`      → `Edit /Users/bytedance/proj/priv/bagakit/agentmu…`
 *   `Edit /Users/…/lib/activity-step-summary.ts`→ `Edit /Users/bytedance/proj/priv/bagakit/agentmu…`
 * 两条**全等**。这条摘要存在的唯一理由就是「不展开也认得出是哪个」，保留头部时它一个字节的识别力
 * 都不提供，比没有摘要更坏——它看起来是答案。
 *
 * 其余字段一律保留头部，各有各的理由，不是「默认值」：
 * - `command`：识别位在动词。`pnpm exec vitest run …` 的头告诉你在跑测试；尾只给最后一个文件参数。
 *   危险命令同理由头识别（`rm -rf …`）。
 * - `url`：头是域名，即这次抓取的身份；尾是查询串。
 * - `pattern` / `query` / `description`：从左读的散文或表达式，头即主语。
 */
const TAIL_IDENTIFIED_FIELDS: ReadonlySet<string> = new Set(['file_path', 'path', 'notebook_path'])

/**
 * 每个工具从哪个字段取摘要。
 *
 * 一个工具可以给多个候选字段，按顺序取第一个非空的——同一个工具在不同 Provider 下字段名可能
 * 不同（`file_path` 与 `path`），但这仍是**声明**而非猜测：候选是写死的，不是从 JSON 里搜出来的。
 */
const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ['command'],
  shell: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  multiedit: ['file_path', 'path'],
  notebookedit: ['notebook_path'],
  glob: ['pattern'],
  grep: ['pattern'],
  websearch: ['query'],
  webfetch: ['url'],
  task: ['description']
}

/** 折行与制表符会把单行标题撑开，压成单个空格；首尾空白一并去掉。 */
function flatten(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * 超长时截断并加省略号，使标题永远只占一行。`keep` 说保留哪一头——理由见 TAIL_IDENTIFIED_FIELDS。
 *
 * **按字素簇切，不按 UTF-16 码元切。** `slice()` 数的是码元，会把一个 emoji 的代理对劈成两半，留下
 * 一个孤立代理项——渲染成 `�`。实测：`…\ude80aaaa….ts`（尾切）与 `aaa…\ud83d…`（头切）两边都中招。
 * 这在路径上不是假想：项目目录带 emoji 很常见，而带 ZWJ 的家族 emoji（`👨‍👩‍👧`）更是一个簇里好几个
 * 码点，`slice` 一刀下去几乎必然劈开。
 *
 * **中日韩不在此列**——常用汉字是单个 BMP 码元，`slice` 永远劈不开它（实测扫遍所有切点：一次孤立
 * 代理项都没有）。汉字的问题是**显示宽度**（47 个码元＝94 格），那是另一件事，别混进来当理由：
 * 一个立不住的动机会让下一个读者以为这里已经解决了宽度问题。宽度见下面那段预算说明。
 *
 * 与 project-monogram 取首字母用的是同一条判断（那条论证在 398ea80d），只是方向相反：那边取
 * **第一个**簇，这边留**最后（或最前）n 个**簇。同一个仓库里对「一个字符是什么」不该有两套答案。
 *
 * 下界：单个簇就超预算时（例如 60 个组合重音叠在一个字母上）两边都留不下任何簇，只剩一个 `…`。
 * 有界、不崩，但也确实什么都没留下。路径里不会出现这种东西，故不为它加一条特例分支。
 *
 * 预算按**码元**算而不是按簇算：上界要守的是「一行放不放得下」，而排版宽度跟码元数更接近（一个
 * emoji 占两格，恰好也是两个码元）。所以这里是「在不超过 limit 个码元的前提下，尽可能多留完整的
 * 簇」——切点只在簇边界上，宁可少留一个簇也不吐半个字符。
 */
export function clampStep(value: string, keep: 'head' | 'tail' = 'head', limit = MAX_STEP_SUMMARY_LENGTH): string {
  if (value.length <= limit) return value
  const budget = limit - 1 // 省略号占一格
  const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
  if (keep === 'tail') {
    let taken = 0
    let start = clusters.length
    // 从尾部往前收，直到再收一簇就会超预算。
    while (start > 0 && taken + clusters[start - 1]!.segment.length <= budget) {
      start -= 1
      taken += clusters[start]!.segment.length
    }
    return `…${value.slice(clusters[start]?.index ?? value.length)}`
  }
  let end = 0
  let taken = 0
  while (end < clusters.length && taken + clusters[end]!.segment.length <= budget) {
    taken += clusters[end]!.segment.length
    end += 1
  }
  return `${value.slice(0, clusters[end]?.index ?? value.length).trimEnd()}…`
}

/**
 * 一步工具调用的参数摘要，取不到则为 null。
 *
 * `toolName` 缺失时**不拿标题去凑**：标题是展示文本，可能已经被上游改写过，用它查表等于把
 * 展示层的措辞当成协议字段。
 */
export function stepSummary(toolName: string | undefined, rawInput: string | undefined): string | null {
  return stepSummaryWithin(toolName, rawInput, MAX_STEP_SUMMARY_LENGTH)
}

/**
 * 同 {@link stepSummary}，但截到调用方给的预算内——给 {@link stepTitle} 用，见那里的「一个预算」说明。
 */
function stepSummaryWithin(
  toolName: string | undefined,
  rawInput: string | undefined,
  limit: number
): string | null {
  if (!toolName || !rawInput) return null
  const fields = SUMMARY_FIELDS[toolName.toLowerCase()]
  if (!fields) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawInput)
  } catch {
    // 坏 JSON 只说明这一步的入参我们读不懂，不说明这一行该消失。如实退回只显示工具名。
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  for (const field of fields) {
    const value = record[field]
    if (typeof value !== 'string') continue
    const flat = flatten(value)
    if (flat) return clampStep(flat, TAIL_IDENTIFIED_FIELDS.has(field) ? 'tail' : 'head', limit)
  }
  return null
}

/**
 * 折叠行的完整标题：工具名，以及（如果取得到）那个最具识别性的参数。
 *
 * 参数缺失时只返回工具名本身——不返回 `Bash ()` 这类空壳，那会让人以为参数是空的，而事实是
 * 我们没读到。
 *
 * **一个预算，只截一次。** 先摘要再拼工具名，合起来会超上界，于是下游只好再截一刀——而那一刀不知道
 * 这半截是路径，会按头部截，把刚刚保住的文件名重新吃掉（实测：`Edit …/lib/session-recency.ts` 53 字符，
 * 被下游头截成 `Edit …desktop/src/renderer/src/lib/session-rece…`，尾部截断白做了）。所以把工具名先占
 * 掉的格子从预算里扣掉，让摘要**一次就截进**最终宽度内：截断方向只在认得字段名的这一层决定，且只决定
 * 一次。
 *
 * 于是返回值**无条件** `<= MAX_STEP_SUMMARY_LENGTH`，调用方不需要、也不该再截——这不是巧合而是承诺，
 * 由测试钉住。工具名自己就超界的那一路也必须守住这条：`title` 就是 hook 载荷里的 `tool_name`
 * 原样（见 hook-normalizer 的 `append(kind, toolName, …)`），而 MCP 工具名形如
 * `mcp__<server>__<tool>`，轻易过 48。放它裸奔出去，承诺就成了「通常成立」，下游读注释的人只能
 * 自己补一刀——那一刀正是本函数要消灭的东西。
 *
 * 承诺只有长度这一条，**不含压平空白**：`title` 原样透传协议里的 `tool_name`，本函数不 flatten 它。
 * 实测 `stepTitle('Web  Search', undefined, undefined)` 返回 `'Web  Search'`（两个空格原样留着）。
 * 今天不成问题，因为工具名是标识符（`Bash`、`mcp__srv__do`）；但那是**假设**而不是证明，所以只写
 * 长度这一条能被测试钉死的。调用方若需要单行保证，自己压平——别把「今天恰好成立」读成契约。
 *
 * 门槛取 `budget <= 1` 而不是 `<= 0`，因为 `clampStep` 在预算 1 上会退化成**只剩一个省略号**
 * （见它的「下界」那段），拼出来就是 `mcp__…__do …`——正是本函数开头说不要的那种空壳：它长得像
 * 「参数是空的」，其实是格子不够。判据是「至少留得下一个真字符」，即 `budget >= 2`。
 * 实测 46 字工具名：`<= 1` 给 `mcp__filesystem-readonly__read_text_file_range`，
 * 改成 `<= 0` 给同一串再加 ` …`。取 `<= 2` 会把预算 2 那一档（`… p…`，一个真字符）也丢掉，
 * 那一档薄但不空，所以留着。
 */
export function stepTitle(title: string, toolName: string | undefined, rawInput: string | undefined): string {
  const prefix = `${title} `
  const budget = MAX_STEP_SUMMARY_LENGTH - prefix.length
  // 工具名本身就撑满一行，没有格子留给摘要了：只保留工具名，并按普通文本截进上界。
  if (budget <= 1) return clampStep(title)
  const summary = stepSummaryWithin(toolName, rawInput, budget)
  return summary ? `${prefix}${summary}` : clampStep(title)
}
