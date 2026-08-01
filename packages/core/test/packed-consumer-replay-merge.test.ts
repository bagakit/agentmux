import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * packed-consumer fixture 里，凡是 reattach 之后要在事件数组里等输出的地方，都必须走合流出口。
 *
 * 来由（实测 2026-09-01）：`attach` 把 attach **之前**的字节放进 `snapshot.replay`，只把之后的喂给
 * 推流。所以同一段字节要么是 replay 要么是 `terminal-output` 事件，**绝不两者都是**。而 Agent 握手
 * （`ensureTerminalHandshake`）自己 attach 一次、在 `finally` 里 detach——attach 是排他的，第二次会
 * `ATTACHMENT_EXISTS`，所以它必须放手。那次 detach 与 fixture 的 reattach 之间有一段没有任何监听者的
 * 窗口，落在窗口里的输出此后只能以 replay 形式出现。只等事件的判据于是漏掉半条流：在那条等待前插
 * 3 秒延迟，让假 CLI 有充足时间在窗口里写完 marker，原本 1/3 概率的永等变成 **100% 永等**。
 *
 * 这条守卫存在的意义是：合流是**约定**，而约定会被下一个人无声地打破——再写一处
 * `await client.reattachAgent(id, 0)` 然后 `waitFor(() => output(events, …))`，同一族竞态就回来了，
 * 而且它在轻负载下大概率是绿的，等到 CI 或别人机器上才红。
 *
 * 判据是**配对关系**而不是"文件里出现过合流函数名"：后者对新增的裸调用完全失明（文件里总还有那七处
 * 在场，名字永远搜得到）。所以这里逐处找裸 `reattachAgent`，再看它后面那段有没有在事件数组里等输出。
 */

const FIXTURE = new URL('./fixtures/packed-consumer.mjs', import.meta.url)
const SOURCE = readFileSync(FIXTURE, 'utf8')
const LINES = SOURCE.split('\n')

/** 一处裸调用（未经合流出口）的行号，0-based。 */
function bareReattachLines(source: string): number[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /\.reattachAgent\s*\(/.test(line))
    .map(({ index }) => index)
}

/**
 * 从某一行往后看 `window` 行，是否在事件数组里等输出。
 *
 * `output(...)` 是 fixture 里唯一从事件数组取终端文本的出口，所以"读了事件数组"等价于"调了 output"。
 */
function waitsOnEventOutput(startLine: number, window = 16): boolean {
  return LINES.slice(startLine + 1, startLine + 1 + window).some((line) => /\boutput\s*\(/.test(line))
}

describe('packed consumer merges agent replay into observed output', () => {
  it('has no reattach that waits on event-array output without merging replay', () => {
    const offenders = bareReattachLines(SOURCE)
      .filter((index) => waitsOnEventOutput(index))
      // 合流出口自己就含一次 `reattachAgent`，它是被允许的那一处。
      .filter((index) => !/const\s*\{\s*attachment\s*\}\s*=/.test(LINES[index]))
      .map((index) => `${index + 1}: ${LINES[index].trim()}`)

    expect(offenders).toEqual([])
  })

  it('detects a bare reattach that waits on event output, so the check above cannot go vacuously green', () => {
    // 自检：把一处合流调用改回裸调用，这条检查必须认出来。判据若退化成"文件里有合流函数名"，
    // 这段注入会静默通过——那正是这条守卫要防的假绿形状。
    const injected = [
      'await someClient.reattachAgent(some.agentSessionId, 0)',
      "await waitFor('some marker', () => (",
      "  output(someEvents, some.run.runId).includes('marker')",
      '))'
    ].join('\n')

    const mutated = `${SOURCE}\n${injected}\n`
    const mutatedLines = mutated.split('\n')
    const detected = bareReattachLines(mutated).filter((index) => (
      mutatedLines.slice(index + 1, index + 17).some((line) => /\boutput\s*\(/.test(line)) &&
      !/const\s*\{\s*attachment\s*\}\s*=/.test(mutatedLines[index])
    ))

    expect(detected.length).toBeGreaterThan(0)
  })

  it('keeps the merge helper pushing replay bytes as terminal-output events', () => {
    // 合流出口可以被改成一个空壳（只 reattach、不 push）而上面两条依旧全绿——那时判据仍然"配对"了，
    // 但配到的是一个什么都不做的函数。所以单独钉住它真的把 replay 写进了事件数组。
    const helper = /async function reattachAgentWithReplay\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(SOURCE)
    expect(helper).not.toBeNull()
    const body = helper![1]
    expect(body).toMatch(/attachment\.replay/)
    expect(body).toMatch(/events\.push\(/)
    expect(body).toMatch(/type:\s*'terminal-output'/)
  })

  it('keeps the CLI helper free of a wall-clock budget', () => {
    // 同一次诊断里的第二个缺陷：`cli()` 那条 15 秒预算在杀健康进程（实测最慢 191ms，撞满 15 秒被
    // SIGTERM）。它极难认，因为 execFile 超时的报错从不说自己超时。所以钉住它别被"顺手加回来"。
    const helper = /const cli = async \([^)]*\) => await execFileAsync\([\s\S]*?\n\}\)/.exec(SOURCE)
    expect(helper).not.toBeNull()
    expect(helper![0]).not.toMatch(/timeout:/)
  })
})
