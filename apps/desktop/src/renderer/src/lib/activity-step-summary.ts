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

/** 超长时截断并加省略号，使标题永远只占一行。 */
function clamp(value: string): string {
  if (value.length <= MAX_STEP_SUMMARY_LENGTH) return value
  return `${value.slice(0, MAX_STEP_SUMMARY_LENGTH - 1).trimEnd()}…`
}

/**
 * 一步工具调用的参数摘要，取不到则为 null。
 *
 * `toolName` 缺失时**不拿标题去凑**：标题是展示文本，可能已经被上游改写过，用它查表等于把
 * 展示层的措辞当成协议字段。
 */
export function stepSummary(toolName: string | undefined, rawInput: string | undefined): string | null {
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
    if (flat) return clamp(flat)
  }
  return null
}

/**
 * 折叠行的完整标题：工具名，以及（如果取得到）那个最具识别性的参数。
 *
 * 参数缺失时只返回工具名本身——不返回 `Bash ()` 这类空壳，那会让人以为参数是空的，而事实是
 * 我们没读到。
 */
export function stepTitle(title: string, toolName: string | undefined, rawInput: string | undefined): string {
  const summary = stepSummary(toolName, rawInput)
  return summary ? `${title} ${summary}` : title
}
