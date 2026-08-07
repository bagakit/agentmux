import { describe, expect, it } from 'vitest'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterEvent,
  type CtxmuxAdapterObservationEvent
} from '../src/ctxmux-run-adapter.js'

// #451a: `decodeChunk` 用有状态的流式解码 `decoder.decode(bytes, { stream: true })`。一个多字节
// UTF-8 字符被切在「replay 的最后一个 chunk」与「第一个 live chunk」之间时，前半截留在 decoder 的
// 内部状态里、由下一个 chunk 补齐。所以 replay 与 live **必须共用同一个 decoder，且 replay 先喂**。
//
// 这里守的具体缺陷有三个形态，都在接缝处解出替换字符 / 乱码而不是那个字符：
//   1. observeOutput 曾给 live 与 replay 各建一个 TextDecoder（历史缺陷）——replay 那半个字符永远补不
//      齐，live decoder 从零把续字节当成新字符开头。
//   2. 有人「顺手」也给 attach() 的 replay 单独建一个 decoder（今天是对的，但没人钉住它是对的）。
//   3. 把 `{ stream: true }` 删掉——即便共用一个 decoder，非流式解码会在每个 chunk 边界立刻 flush，
//      半个字符当场变成替换字符。
//
// 判据是**行为**的：断言接缝处那个字符完整正确，而不是数 `new TextDecoder()` 出现几次（换个写法就绕过，
// 且不问「解出来对不对」）。'中' 占 3 字节 e4 b8 ad；我们把它切成 replay 尾部两字节 + live 首字节。

// replay 的最后一个 chunk：'ab' + '中' 的前两字节（e4 b8）——在一个字符正中间截断。
const REPLAY_SEAM_BYTES = Uint8Array.from([0x61, 0x62, 0xe4, 0xb8])
// 紧接着的第一个 live chunk：'中' 的最后一字节（ad）+ 'cd'。
const LIVE_SEAM_BYTES = Uint8Array.from([0xad, 0x63, 0x64])
// 接缝两侧拼起来应当是这个——'中' 完整，无替换字符。整串相等就是判据：替换字符（U+FFFD）出现即不等，
// 所以**不要**在它旁边再加一句 `not.toContain('�')`。那句先天多余（`toBe` 先抛，它成死代码），
// 单独留着还更弱——空串与 'ab' 都能过。此前两条用例各带一句，已删。
const EXPECTED_SEAM_TEXT = 'ab中cd'

function seamReplayChunk(): OutputChunk {
  return { start_byte: 0, end_byte: REPLAY_SEAM_BYTES.byteLength, data: REPLAY_SEAM_BYTES }
}

function seamLiveOutputEvent(): RunEvent {
  return {
    type: 'output',
    chunk: {
      start_byte: REPLAY_SEAM_BYTES.byteLength,
      end_byte: REPLAY_SEAM_BYTES.byteLength + LIVE_SEAM_BYTES.byteLength,
      data: LIVE_SEAM_BYTES
    }
  }
}

// 同一份构造两条用例共用：replay 尾字节切在字符中间，然后 live 送来该字符的续字节，最后干净退出，
// 让 pump/observeOutput 的事件循环正常收尾（不触发 connection-lost 噪声）。
async function* seamEvents(): AsyncGenerator<RunEvent, void, void> {
  yield seamLiveOutputEvent()
  yield { type: 'exited', state: { type: 'exited', code: 0, signal: null } }
}

// 一个只实现 adapter 会碰到的成员的假 Attachment：snapshot（run + 一个 replay chunk）、events()、
// detach/close。整体在赋值给假 client 时再 cast，故这里不用凑齐 RunInfo / RunBackend 的全部字段。
function seamAttachment(events: () => AsyncGenerator<RunEvent, void, void>) {
  return {
    snapshot: {
      run: {
        id: 'seam-run',
        spec: null,
        lineage: null,
        pid: null,
        state: { type: 'running' as const },
        latest_output_bytes: REPLAY_SEAM_BYTES.byteLength + LIVE_SEAM_BYTES.byteLength,
        durable_output_bytes: null,
        first_available_byte: 0,
        attachments: 1,
        applied_input_bytes: null
      },
      replay: {
        chunks: [seamReplayChunk()],
        first_available_byte: 0,
        latest_output_bytes: REPLAY_SEAM_BYTES.byteLength + LIVE_SEAM_BYTES.byteLength,
        truncated: false
      }
    },
    events,
    detach: async () => {},
    close: () => {}
  }
}

function primeWithSeamAttachment(adapter: CtxmuxRunAdapter): void {
  // requireClient() 只调 client.attach(runId, afterByte)；给它一个每次都返回同一个接缝 attachment 的
  // 假 client。cast 走 disconnect 测试同款私有字段注入。
  ;(adapter as unknown as { client: unknown }).client = {
    attach: async () => seamAttachment(seamEvents)
  }
}

// 事件循环由 `void (async …)()` / `void this.pump(…)` 异步驱动；让出宏任务直到 live 的 data 事件到达
// （或用尽预算）。用 setTimeout(0) 而非只泵 microtask，确保管线里任何 macrotask 也能跑完。
async function waitForDataEvent(seen: { type: string }[]): Promise<void> {
  for (let attempt = 0; attempt < 100 && !seen.some((event) => event.type === 'data'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function joinDataText(events: { type: string; data?: string }[]): string {
  return events
    .filter((event): event is { type: 'data'; data: string } => event.type === 'data')
    .map((event) => event.data)
    .join('')
}

describe('CtxmuxRunAdapter 接缝处的多字节字符解码（replay↔live 共用一个流式 decoder）', () => {
  it('observeOutput：切在字符中间的 replay 尾字节由第一个 live chunk 补齐，接缝字符完整无乱码', async () => {
    const adapter = new CtxmuxRunAdapter()
    primeWithSeamAttachment(adapter)
    const live: CtxmuxAdapterObservationEvent[] = []

    const observation = await adapter.observeOutput('seam-run', 0, (event) => live.push(event))
    await waitForDataEvent(live)

    const text = joinDataText([...observation.replay, ...live])
    // 若 observeOutput 回到「给 replay 单独建一个 replayDecoder」的历史形状，接缝处会解出替换字符，
    // 整串因此不等——这一句就红。
    expect(text).toBe(EXPECTED_SEAM_TEXT)
  })

  it('attach：同形——replay 与后续 live 事件共用一个 decoder，接缝字符完整无乱码', async () => {
    const adapter = new CtxmuxRunAdapter()
    primeWithSeamAttachment(adapter)
    const live: CtxmuxAdapterEvent[] = []
    adapter.onEvent((event) => live.push(event))

    const attachment = await adapter.attach('seam-run', 0)
    await waitForDataEvent(live)

    const text = joinDataText([...attachment.replay, ...live])
    // attach() 今天是对的（一个 decoder 传进 pump）。若有人给它的 replay 也单独建一个 decoder，
    // 整串就不等——这一句红，钉住「它是对的」。
    expect(text).toBe(EXPECTED_SEAM_TEXT)
  })
})
