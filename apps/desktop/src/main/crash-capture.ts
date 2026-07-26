/**
 * 崩溃事件的纯决策逻辑：把一次崩溃「该记成什么」和「记到磁盘上要不要裁」这两件事从 Electron 接线里
 * 剥出来，做成没有任何副作用、可直接断言的纯函数。index.ts 里 electron API 在测试环境跑不起来，
 * 所以承重逻辑不能待在接线层——那里没有任何断言够得着。
 *
 * 事前诊断（doctor）已经很强，缺的是事后信号：渲染进程崩了、子进程没了、主进程有个没人接的
 * rejection，今天事后完全不可见。这里定义这些事件统一归一成什么记录、以及落盘时如何守住体量上界，
 * 好让崩溃循环写不满磁盘。
 *
 * 隐私底线：这里只产出要写进本地文件的一行 NDJSON，不含任何网络出口。「不上传」是这条能力的硬约束。
 */

/** 四类事后可见的崩溃来源。渲染进程与子进程崩溃走 Electron 的 app 事件，未捕获异常/拒绝走 process。 */
export type CrashKind =
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'render-process-gone'
  | 'child-process-gone'

/**
 * 这次崩溃是否致命到主进程本身。为真时接线层必须留证后 fail-fast——挂上 process 处理器会抑制
 * Node 对 uncaughtException（默认 print+exit(1)）和 unhandledRejection（默认 throw 终止）的兜底，
 * 若只记录不退出，主进程会带着半损坏的运行时继续活着，把硬崩溃变成用户毫无察觉的静默崩溃。
 *
 * 渲染进程/子进程消失不算致命：Electron 主进程按设计能在渲染器、GPU、Utility 进程死掉后继续存活，
 * 为一个 GPU 进程崩溃就杀掉整个主进程反而是更糟的回归。这类只需异步留证、进程照常运行。
 */
export function isFatalToMainProcess(kind: CrashKind): boolean {
  return kind === 'uncaught-exception' || kind === 'unhandled-rejection'
}

/** 各来源的原始入参。用可辨识联合而不是一个大 any，让「该记成什么」的分支有编译器兜底。 */
export type CrashEventInput =
  | { kind: 'uncaught-exception'; error: unknown }
  | { kind: 'unhandled-rejection'; reason: unknown }
  | {
      kind: 'render-process-gone'
      details: { reason?: string; exitCode?: number }
      url?: string
    }
  | {
      kind: 'child-process-gone'
      details: { type?: string; reason?: string; exitCode?: number; serviceName?: string; name?: string }
    }

/**
 * 归一后的崩溃记录。summary 是一眼能读懂的一句话，detail 承载栈或 URL 这种可能很长、也可能没有的补充。
 * at 用 ISO 字符串，落盘后不依赖读取端的时区。
 */
export type CrashRecord = {
  at: string
  kind: CrashKind
  summary: string
  detail?: string
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name || 'Error'
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function stackOf(value: unknown): string | undefined {
  return value instanceof Error && typeof value.stack === 'string' ? value.stack : undefined
}

/**
 * 单条记录里两个字段的字节上界。summary 是一句话，detail 才可能很长（整条栈）。给它们各设上界，
 * 保证一行序列化后远小于文件体量上界（默认 1 MiB）——这样 appendWithinBudget 永远不会走到「整行
 * 拦腰截断」那条路，每一行都始终是可 JSON.parse 的完整记录。截断处补省略号，读的人知道被裁过。
 */
const SUMMARY_MAX_BYTES = 4 * 1024
const DETAIL_MAX_BYTES = 128 * 1024
const ELLIPSIS = '…'

/** 把字段截到字节上界内，超了就补省略号，让读取端一眼看出这条被裁过。未超则原样返回。 */
function clampField(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, 'utf8')
  return `${truncateToBytes(value, maxBytes - ellipsisBytes)}${ELLIPSIS}`
}

/** 归一记录的统一出口：summary/detail 都过一遍字节上界，保证序列化后每行始终可解析。 */
function buildRecord(at: string, kind: CrashKind, summary: string, detail?: string): CrashRecord {
  const record: CrashRecord = { at, kind, summary: clampField(summary, SUMMARY_MAX_BYTES) }
  return detail === undefined ? record : { ...record, detail: clampField(detail, DETAIL_MAX_BYTES) }
}

/**
 * 决定一次崩溃「该记成什么」。nowMs 注入而不是内部读时钟，这样测试能断言确定的时间戳，
 * 也让归一逻辑本身没有任何隐藏输入。
 *
 * 只做归一，不决定要不要退出、要不要提醒——那些是接线层的策略，混进来会让这个纯函数不可复用也难断言。
 */
export function crashRecordFrom(input: CrashEventInput, nowMs: number): CrashRecord {
  const at = new Date(nowMs).toISOString()
  switch (input.kind) {
    case 'uncaught-exception':
      return buildRecord(at, input.kind, messageOf(input.error), stackOf(input.error))
    case 'unhandled-rejection':
      return buildRecord(at, input.kind, messageOf(input.reason), stackOf(input.reason))
    case 'render-process-gone': {
      const reason = input.details.reason ?? 'unknown'
      const exitCode = input.details.exitCode ?? 0
      return buildRecord(at, input.kind, `renderer ${reason} (exit ${exitCode})`, input.url)
    }
    case 'child-process-gone': {
      const type = input.details.type ?? 'unknown'
      const reason = input.details.reason ?? 'unknown'
      const exitCode = input.details.exitCode ?? 0
      const named = input.details.serviceName ?? input.details.name
      return buildRecord(at, input.kind, `${type} ${reason} (exit ${exitCode})`, named)
    }
  }
}

/** 一条记录序列化成一行 NDJSON（不含换行）。追加逻辑负责补换行，避免空文件首行是空行。 */
export function serializeCrashRecord(record: CrashRecord): string {
  return JSON.stringify(record)
}

/**
 * 把新一行追加进现有 NDJSON 内容，并守住 maxBytes 的体量上界：从最旧的行开始丢，直到总量不超过上界。
 * 这就是「崩溃循环不能写满磁盘」的那道闸——落盘的量有硬顶，旧的自然滚掉。
 *
 * 两个边界：
 * - 单独一行就超过上界时（比如一条巨型栈），把这一行截断到上界，而不是无条件保留导致越界。
 * - 结果始终以换行结尾，NDJSON 的每一行都是完整的一条，读取端按行切不会读到半条。
 */
export function appendWithinBudget(existing: string, line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  // 单行超顶：截断这一行本身，保证任何单次崩溃都写不爆上界。
  if (Buffer.byteLength(`${line}\n`, 'utf8') > maxBytes) {
    const truncated = truncateToBytes(line, maxBytes - 1)
    return `${truncated}\n`
  }
  const previousLines = existing.split('\n').filter((entry) => entry.length > 0)
  const lines = [...previousLines, line]
  // 从最旧的行往下丢，直到装得下。新行永远保留（上面已保证它单独装得下）。
  while (lines.length > 1 && Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8') > maxBytes) {
    lines.shift()
  }
  return `${lines.join('\n')}\n`
}

/** 按 UTF-8 字节数截断，绝不在多字节字符中间切开，避免写出坏字节序列。 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= maxBytes) return value
  // 从上界处往回退到字符边界：UTF-8 的续接字节高两位恒为 10，退到第一个非续接字节就是下一个字符的
  // 起点，在那里切。走 Buffer 按字节退，避免按 code unit 逐次重算 byteLength 的 O(n²)。
  let end = maxBytes
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buf.toString('utf8', 0, end)
}
