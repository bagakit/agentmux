import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  admitTerminalLiveOutput,
  takeTerminalLiveOutputBatch,
  TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES,
  type TerminalLiveOutputChunk
} from '../src/renderer/src/lib/terminal-live-output'

// ---------------------------------------------------------------------------
// live 输出队列的上界。
//
// 缺陷形状：attach 之后 renderer 的 accept 无条件 push 进 liveOutputQueue，而那个队列**无界**。
// 有界保护只存在于 attach 前的启动缓冲（MAX_PENDING_OUTPUT_EVENTS / _BYTES），进入 live 后就没了。
// 生产者也不可能被拖慢——acknowledger 是纯记账（只校验 cursor ≤ latestOutputBytes），core 全仓无
// pause/resume/credit 调用。
//
// 于是失败模式不是丢字节、也不是硬冻，而是 renderer 堆随「已产出 − 已 parse」近似线性上涨：agent
// `cat` 一个 50MB 文件是几十 MB 尖峰，`yes` 跑几秒能产出数百 MB，够 GC 抖动乃至 OOM。而 scrollback
// 只有 5000 行——这几十上百 MB parse 完立刻被挤出缓冲，纯属为马上滚没的行做无用功。
//
// 所以判据不是「一个字节都不许丢」（那要求 daemon 支持 pause/resume，vendored 二进制换不得），而是
// 「保留量有界、cursor 不倒退、省略如实说出来」。
// ---------------------------------------------------------------------------

function chunk(startByte: number, size: number): TerminalLiveOutputChunk {
  return { data: 'x'.repeat(size), startByte, endByte: startByte + size }
}

function totalBytes(chunks: readonly TerminalLiveOutputChunk[]): number {
  return chunks.reduce((sum, item) => sum + (item.endByte - item.startByte), 0)
}

/** 把一串块逐个喂进去，模拟真实的逐事件入队。 */
function admitAll(
  sizes: readonly number[],
  maxBytes: number
): { queue: TerminalLiveOutputChunk[]; droppedBytes: number } {
  let queue: TerminalLiveOutputChunk[] = []
  let droppedBytes = 0
  let nextByte = 0
  for (const size of sizes) {
    const admitted = admitTerminalLiveOutput(queue, chunk(nextByte, size), maxBytes)
    queue = admitted.queue
    droppedBytes += admitted.droppedBytes
    nextByte += size
  }
  return { queue, droppedBytes }
}

describe('live 输出积压的上界', () => {
  it('积压不超过上限——退回无界 push 时这条红', () => {
    const { queue } = admitAll(Array.from({ length: 40 }, () => 100), 1_000)
    // 先证队列真的非空（否则「0 ≤ 上限」是在空队列上恒真）。
    expect(queue.length).toBeGreaterThan(0)
    expect(totalBytes(queue)).toBeLessThanOrEqual(1_000)
  })

  it('丢的是队头，留下的是最新的字节——丢队尾会让终端停在过去', () => {
    // 队尾是用户正在看的那一屏。判据钉「最后一块还在」，而不只是「数量变少了」：把 shift 改成 pop
    // 时数量照旧减少，这条才认得出。
    const { queue } = admitAll([400, 400, 400, 400], 1_000)
    expect(queue.at(-1)).toMatchObject({ startByte: 1_200, endByte: 1_600 })
    expect(queue.some((item) => item.startByte === 0)).toBe(false)
  })

  it('留下的那截内部连续——这是「恰好一条省略告示」的来源', () => {
    // drain 是按「这一块的 startByte 对不上 cursor」发告示的。只要留下的部分内部连续，无论丢了
    // 多少次、多少块，都只有队头那**一处**不连续，也就只发一条。若改成从中间挖掉一段，这条会红，
    // 而用户会看到一屏里散落多条 [Output sequence gap] 告示。
    const { queue } = admitAll(Array.from({ length: 30 }, () => 200), 1_000)
    for (let index = 1; index < queue.length; index += 1) {
      expect(queue[index]!.startByte, '第 ' + index + ' 块与前一块之间出现了空洞').toBe(
        queue[index - 1]!.endByte
      )
    }
  })

  it('永不清空：至少留住刚收到的那一块', () => {
    // 上限比单块还小的极端情形。清空等于这一刻的终端什么都不显示，且 cursor 再也追不上产出。
    const admitted = admitTerminalLiveOutput([], chunk(0, 5_000), 100)
    expect(admitted.queue).toHaveLength(1)
    expect(admitted.queue[0]).toMatchObject({ startByte: 0, endByte: 5_000 })
  })

  it('没超上限时一块都不丢——不许平时就悄悄扔字节', () => {
    // 反向那一侧。若实现无条件丢队头（或上限写成 0），上面几条仍绿而用户在**正常**输出下就开始
    // 看到省略告示。
    const { queue, droppedBytes } = admitAll([100, 100, 100], 1_000)
    expect(droppedBytes).toBe(0)
    expect(queue).toHaveLength(3)
    expect(totalBytes(queue)).toBe(300)
  })

  it('丢了多少字节如实报出来——调用方要靠它判断该不该说省略', () => {
    const { droppedBytes } = admitAll([600, 600, 600], 1_000)
    expect(droppedBytes).toBeGreaterThan(0)
  })

  it('默认上限是个真数字，且远大于一屏、远小于会抖动的量级', () => {
    // 不钉死具体值（那会让调参变成改测试），只钉它落在合理区间：小于 256KiB 会在正常输出下就截断，
    // 大于 32MiB 就回到了本缺陷要治的那个量级。
    expect(TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES).toBeGreaterThan(256 * 1024)
    expect(TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES).toBeLessThan(32 * 1024 * 1024)
  })

  it('裁剪不破坏取批：取出的前缀仍是原顺序', () => {
    // 两个纯函数要能串起来用。admit 之后 take 出来的第一块必须就是队头，否则终端会乱序。
    const { queue } = admitAll(Array.from({ length: 20 }, () => 300), 2_000)
    const taken = takeTerminalLiveOutputBatch(queue, 700)
    expect(taken.batch[0]).toEqual(queue[0])
    expect([...taken.batch, ...taken.rest]).toEqual(queue)
  })
})

describe('TerminalView 真的经过了这道闸', () => {
  // 本仓有「抽进 lib 只解决一半」的先例：内容变可测了，而那层壳有没有被执行到照旧无人守——
  // 搬完再往壳里插一句早退，测试仍全绿。所以这里钉住组件里那个唯一入队点确实**经过** admit。
  const source = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )

  it('唯一的 live 入队点走 admitTerminalLiveOutput，而不是裸 push', () => {
    expect(source).toContain('admitTerminalLiveOutput(liveOutputQueue')
    // 裸 push 一处都不许剩：留一条旁路就等于没有上界。注意 splice(…, ...admitted.queue) 是写回，
    // 不是入队，所以这条不会误伤。
    expect(source).not.toContain('liveOutputQueue.push(')
  })

  it('从 lib 导入，不是就地又抄了一份判据', () => {
    // 判据要是 import 关系。本仓栽过「not.toContain('name(') 被裸标识符绕过」，所以这里查导入路径。
    expect(source).toContain("from '../lib/terminal-live-output'")
  })
})
