/**
 * 把一次编辑工具调用，变成能一眼看懂的 diff——纯逻辑层。
 *
 * Edit/Write/MultiEdit 的 `toolInput` 现在是一整串转义 JSON，直接倒进 `<pre>`（见
 * ActivityView.tsx 的 log-row__payload）。用户看到的是
 * `{"file_path":"…","old_string":"…","new_string":"…"}` 这样一坨，要在脑子里把
 * old/new 对齐着比——**这件事本该由机器做**。这里就做这件事：给出 added / removed /
 * context 三类行，让渲染层只管上色。
 *
 * 写成纯函数、放在 lib/ 而不是塞进 JSX：本仓库测试用 `renderToStaticMarkup`，effect 不跑、
 * DOM 事件点不动，凡是承载判断的分支都必须在纯函数里才断言得到。与 continuity-failure-notice
 * 同一条理由。
 *
 * 两个入口共用一种输出（{@link ToolDiff}）：一条是结构化的工具入参（我们自己算 diff），另一条
 * 是别的工具已经吐出来的 unified diff 文本（我们只做识别与解析）。渲染层因此只需认一种形状。
 */

/**
 * 单行 diff 的类别。`hunk` 既承载 unified diff 的 `@@ … @@` 段头，也承载 MultiEdit 里
 * 各条编辑之间的分隔标记——两者都是"这不是内容、是结构边界"，归成一类让渲染层少一个分支。
 */
export type DiffLineKind = 'added' | 'removed' | 'context' | 'hunk'

/** 一行 diff。`text` 已剥掉 `+`/`-`/前导空格，渲染层不必再处理前缀。 */
export type DiffLine = { kind: DiffLineKind; text: string }

/**
 * 一次编辑的可显示形态。`filePath` 用 optional 而非 `string | undefined`：exactOptionalPropertyTypes
 * 打开时两者不等价，缺路径时这个键要"根本不存在"，靠 spread-conditional 达成。
 */
export type ToolDiff = {
  lines: DiffLine[]
  /**
   * 是否因为过长被截断。**必须是显式信号，不能是静默地少几行**：用户看不见的截断会让他以为
   * 编辑只改了这么点，从而做出错误判断。渲染层据此显式标注"其余已省略"。
   */
  truncated: boolean
  filePath?: string
}

/**
 * 单次 diff 最多渲染的行数上限。超出即截断并置 `truncated`。
 *
 * 200 行是"够看清一次改动、又不至于把整条时间线撑爆"的折中：payload 只是预览，真要读全文
 * 该去看文件本身。做成具名常量而非散落的魔数，方便测试与渲染层引用同一个值。
 */
export const MAX_DIFF_LINES = 200

/**
 * 把一次工具调用的入参转成 diff 行；不是编辑类调用则返回 null。
 *
 * `rawInput` 是**字符串**，可能是合法 JSON、也可能不是。JSON 坏掉时返回 null，**绝不抛**——
 * 上游（ActivityView）没有 try/catch，一抛整行就白屏。返回 null 让它安静回退到原来的裸文本。
 */
export function toolCallToDiff(toolName: string, rawInput: string): ToolDiff | null {
  const parsed = safeParseObject(rawInput)
  if (!parsed) return null

  // 只认这三个 Claude Code 工具名（精确匹配）。别的工具的入参形状我们没有把握，宁可返回 null
  // 让渲染层照旧显示，也不猜。
  switch (toolName) {
    case 'Edit':
      return editDiff(parsed)
    case 'MultiEdit':
      return multiEditDiff(parsed)
    case 'Write':
      return writeDiff(parsed)
    default:
      return null
  }
}

/**
 * 把已经是 unified diff 形状的文本解析成同一套 diff 行；不是 diff 就返回 null。
 *
 * "是不是 diff" 的判定卡在一条明确的线上：**要么带 ```diff 围栏、要么至少有一个 `@@` 段头**。
 * 只看 `+`/`-` 开头会把 Markdown 列表（`- 买牛奶`）误判成删除行——围栏和 `@@` 是 unified diff
 * 唯一不含糊的自证，用它们当门槛才不会把普通文本染成 diff。
 */
export function parseUnifiedDiff(text: string): ToolDiff | null {
  const { body, fenced } = stripDiffFence(text)
  const rawLines = splitDiffBody(body)

  const lines: DiffLine[] = []
  let sawHunk = false

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      sawHunk = true
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    // `diff `/`index ` 这类文件头与内容行永不冲突（内容行以 +/-/空格 起头），可以无条件当结构行。
    // 见到新一段 `diff ` 说明进入了下一个文件的头部，重置 sawHunk 好让它的 `---`/`+++` 再被认作头。
    if (UNAMBIGUOUS_HEADER.test(raw)) {
      if (raw.startsWith('diff ')) sawHunk = false
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    // `--- `/`+++ ` 与删除/新增行同形，只有在还没进入 hunk 体（文件头区）时才当文件头。
    if (!sawHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      lines.push({ kind: 'hunk', text: raw })
      continue
    }

    const marker = raw[0]
    if (marker === '+') {
      lines.push({ kind: 'added', text: raw.slice(1) })
    } else if (marker === '-') {
      lines.push({ kind: 'removed', text: raw.slice(1) })
    } else if (marker === ' ') {
      lines.push({ kind: 'context', text: raw.slice(1) })
    } else if (marker === '\\') {
      // `\ No newline at end of file`——是注记不是内容，原样留作 context。
      lines.push({ kind: 'context', text: raw })
    } else if (fenced) {
      // 围栏内我们已经信了它是 diff，无前缀的行当作 context 收下。
      lines.push({ kind: 'context', text: raw })
    } else {
      // 无围栏、又出现了不带 diff 前缀的行——这不是一段 diff。
      return null
    }
  }

  const diffShaped = fenced || sawHunk
  if (!diffShaped || lines.length === 0) return null
  return capped(lines, undefined)
}

/** Edit：file_path/old_string/new_string。缺 old/new 不成其为编辑，返回 null。 */
function editDiff(input: Record<string, unknown>): ToolDiff | null {
  const oldString = asString(input.old_string)
  const newString = asString(input.new_string)
  if (oldString === undefined || newString === undefined) return null
  return capped(lineDiff(oldString, newString), asString(input.file_path))
}

/** Write：file_path/content——整份内容都是新增。 */
function writeDiff(input: Record<string, unknown>): ToolDiff | null {
  const content = asString(input.content)
  if (content === undefined) return null
  const lines: DiffLine[] = splitLines(content).map((text) => ({ kind: 'added', text }))
  return capped(lines, asString(input.file_path))
}

/** MultiEdit：一个 edits 数组，逐条施加于同一文件。 */
function multiEditDiff(input: Record<string, unknown>): ToolDiff | null {
  const edits = input.edits
  if (!Array.isArray(edits) || edits.length === 0) return null

  const lines: DiffLine[] = []
  let editNo = 0
  for (const raw of edits) {
    // 有一条编辑形状不对就整体返回 null：只渲染其中几条会谎报这次调用到底改了什么，
    // 不如回退到裸文本让用户看到全貌。
    if (typeof raw !== 'object' || raw === null) return null
    const edit = raw as Record<string, unknown>
    const oldString = asString(edit.old_string)
    const newString = asString(edit.new_string)
    if (oldString === undefined || newString === undefined) return null

    editNo += 1
    // MultiEdit 是**有序的一串**编辑，边界本身有意义（先后决定 old_string 能不能被找到）。
    // 不加分隔就会让第 N 条的新增和第 N+1 条的删除连成一片，又回到"脑内对齐"的老问题。
    lines.push({ kind: 'hunk', text: `@@ edit ${editNo} @@` })
    lines.push(...lineDiff(oldString, newString))
  }
  return capped(lines, asString(input.file_path))
}

/**
 * 行级 diff：掐掉公共前缀与公共后缀，中间旧行记为 removed、新行记为 added。
 *
 * 这是刻意的朴素做法而非 Myers：Edit 的 old/new 本就是小片段，去掉两头相同的行、把真正变动的
 * 中段摆成"先删后增"，已经足够让人一眼看清；上一个 Myers 反而是过度工程。两头相同的行留作
 * context 当锚点。
 */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }

  const lines: DiffLine[] = []
  for (let i = 0; i < start; i += 1) lines.push({ kind: 'context', text: oldLines[i]! })
  for (let i = start; i < oldEnd; i += 1) lines.push({ kind: 'removed', text: oldLines[i]! })
  for (let i = start; i < newEnd; i += 1) lines.push({ kind: 'added', text: newLines[i]! })
  for (let i = oldEnd; i < oldLines.length; i += 1) lines.push({ kind: 'context', text: oldLines[i]! })
  return lines
}

/** 套上上限与可选的文件路径。空行数视作"没什么可显示"，返回 null。 */
function capped(lines: DiffLine[], filePath: string | undefined): ToolDiff | null {
  if (lines.length === 0) return null
  const truncated = lines.length > MAX_DIFF_LINES
  const kept = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines
  return { lines: kept, truncated, ...(filePath !== undefined ? { filePath } : {}) }
}

/**
 * 按 `\n` 切行。末尾换行会切出一个多余的空串，掐掉一个——否则每份文件末尾都会凭空多出一行空行。
 * 空字符串切成零行（一次空 Write 没有可显示的行）。
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** JSON.parse 包一层：坏 JSON、或解析出来不是对象，一律返回 null，绝不抛。 */
function safeParseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

// `diff `/`index ` 等——与 +/-/空格 起头的内容行永不冲突，可无条件当结构行。
const UNAMBIGUOUS_HEADER =
  /^(diff |index |new file mode|deleted file mode|old mode |new mode |similarity index |dissimilarity index |rename |copy |Binary files )/

/** 若整段文本是一个 ```diff（或 ~~~diff）围栏，剥掉围栏交出内部；否则原样返回并标记未围栏。 */
function stripDiffFence(text: string): { body: string; fenced: boolean } {
  const fence = /^\s*(```+|~~~+)[ \t]*diff[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*\1[ \t]*\s*$/i
  const match = fence.exec(text)
  if (match) return { body: match[2] ?? '', fenced: true }
  return { body: text, fenced: false }
}

/** 切开 diff 正文：掐掉末尾空行，逐行去掉 CRLF 的 `\r`。 */
function splitDiffBody(body: string): string[] {
  const parts = body.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}
