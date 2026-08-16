import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type RunEvent, type RunInfo } from '@ctxmux/sdk'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterObservationEvent
} from '../src/ctxmux-run-adapter.js'

/**
 * Run 投影必须用 owner-confirmed `current_size`，不能把 `RunSpec.size` 当成当前尺寸。
 *
 * 启动 80x24、resize 到 200x87 之后，status/attach/list 都要报 200x87，spec 仍是 80x24。
 * `current_size: null` 是明确的 unknown，不得回退成 spec.size。
 */

const encoder = new TextEncoder()

async function write(screen: AgentTerminalScreen, data: string): Promise<void> {
  const dataBytes = encoder.encode(data)
  await screen.write({
    startByte: screen.throughByte,
    endByte: screen.throughByte + dataBytes.byteLength,
    dataBytes
  })
}

/**
 * 返回 `RunInfo`（而不是 `unknown`）是刻意的：protocol 17 把 `RunSpec.size` 改名成
 * `initial_size` 并去掉了 `#[serde(default)]`。上游把它做成 breaking rename 的**目的**就是让
 * 每个消费点在 tsc 上显形；而一个 `unknown` 的 fixture 会把这份保护整块吃掉——里面写旧字段名
 * 编译器一声不响，于是这个专门守「别拿 spec 的启动尺寸当当前尺寸」的文件会带着过期形状照绿。
 */
function runInfo(currentSize: { cols: number; rows: number } | null): RunInfo {
  return {
    id: 'resize-run',
    spec: {
      program: 'codex',
      args: [],
      cwd: '/tmp/resize-run',
      env: {},
      initial_size: { cols: 80, rows: 24 },
      declared_inputs: []
    },
    lineage: null,
    backend: { type: 'native' },
    capabilities: {
      input: true,
      resize: true,
      signal: true,
      stop: true,
      fork_level_a: false,
      fork_level_b: false,
      replay: 'raw_from_start'
    },
    pid: 4321,
    state: { type: 'running' },
    latest_output_bytes: 0,
    durable_output_bytes: 0,
    first_available_byte: 0,
    attachments: 1,
    applied_input_bytes: 0,
    current_size: currentSize
  }
}

function adapterWith(options: {
  currentSize: { cols: number; rows: number } | null
  appliedSize?: { cols: number; rows: number }
}): CtxmuxRunAdapter {
  const adapter = new CtxmuxRunAdapter()
  let current = options.currentSize
  ;(adapter as unknown as { client: unknown }).client = {
    resize: async () => {
      const applied = options.appliedSize ?? { cols: 200, rows: 87 }
      current = applied
      return {
        run: runInfo(current),
        receipt: { type: 'resize', applied_size: applied }
      }
    },
    status: async () => runInfo(current),
    list: async () => [runInfo(current)]
  }
  return adapter
}

describe('Run 投影报告 owner-confirmed current_size，而不是 spec.size', () => {
  it('start 80x24、resize 200x87 之后，status/list 报 current_size，spec 仍是启动尺寸', async () => {
    const adapter = adapterWith({
      currentSize: { cols: 80, rows: 24 },
      appliedSize: { cols: 200, rows: 87 }
    })

    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: 80, rows: 24 })

    const resized = await adapter.resize('resize-run', 200, 90)
    expect({ cols: resized.cols, rows: resized.rows }).toEqual({ cols: 200, rows: 87 })
    expect(resized.run).toMatchObject({ cols: 200, rows: 87 })

    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: 200, rows: 87 })
    const [listed] = await adapter.list()
    expect(listed).toMatchObject({ cols: 200, rows: 87 })
  })

  it('current_size 为 null 时保持 unknown，不回退成 spec.size', async () => {
    const adapter = adapterWith({ currentSize: null })
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: null, rows: null })
  })

  it('刚成功 resize 过，owner 随后报 null 也必须是 null——不许留一份缓存顶上', async () => {
    // 上一条用的是**全新 adapter**：它从没见过任何尺寸，所以「不缓存」这个性质在那里是空转的。
    // 判别力只在「刚刚见过一个尺寸」时才出现，所以这里先真做一次 resize 拿到 200x87，再让 owner 报 null。
    //
    // 曾经有一本本地台账记着我们自己发起的 resize，用来在快照没有 `current_size` 字段时顶上；protocol 16
    // 把该字段变成必填，台账随之删掉。这条用例留下来守的是**删掉之后**的性质：`null` 是 owner 在说
    // 「我现在也不知道」，任何形式的缓存回填都不许把它改写成一个看起来权威的陈旧尺寸——屏幕证据会按那个
    // 错尺寸重建，而它要拿去做严格等值比较。谁再加回一层缓存，这条立刻红。
    const adapter = adapterWith({ currentSize: { cols: 80, rows: 24 }, appliedSize: { cols: 200, rows: 87 } })
    await adapter.resize('resize-run', 200, 90)
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: 200, rows: 87 })

    ;(adapter as unknown as { client: { status: () => Promise<unknown> } }).client.status =
      async () => runInfo(null)
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: null, rows: null })
  })
})

describe('折行随屏幕宽度重算——这是尺寸必须正确的原因', () => {
  it('用启动宽度解析 resize 后的输出，会读出与真实终端不同的 composer 内容', async () => {
    const redraw = '[2J[22;1H› head[22;150Htail'

    const stale = new AgentTerminalScreen(80, 24)
    const fresh = new AgentTerminalScreen(200, 87)
    try {
      await write(stale, redraw)
      await write(fresh, redraw)

      expect(fresh.composerText('›')).toBe(`head${' '.repeat(143)}tail`)
      expect(stale.composerText('›')).not.toBe(fresh.composerText('›'))
    } finally {
      stale.dispose()
      fresh.dispose()
    }
  })
})

describe('Resized 是几何事件，不是进程退出', () => {
  it('observeOutput 把 Resized 投递给观察者，且**不**把它记进任何本地尺寸记录', async () => {
    const adapter = new CtxmuxRunAdapter()
    const seen: CtxmuxAdapterObservationEvent[] = []
    async function* events(): AsyncGenerator<RunEvent, void, void> {
      yield { type: 'resized', size: { cols: 200, rows: 87 } } as unknown as RunEvent
      yield { type: 'exited', state: { type: 'exited', code: 0, signal: null } }
    }
    ;(adapter as unknown as { client: unknown }).client = {
      attach: async () => ({
        snapshot: {
          run: runInfo({ cols: 80, rows: 24 }),
          replay: {
            chunks: [],
            first_available_byte: 0,
            latest_output_bytes: 0,
            truncated: false
          }
        },
        events,
        detach: async () => {},
        close: () => {}
      }),
      status: async () => runInfo(null)
    }

    const observation = await adapter.observeOutput('resize-run', 0, (event) => seen.push(event))
    expect(observation.run).toMatchObject({ cols: 80, rows: 24 })
    for (let attempt = 0; attempt < 50 && seen.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(seen.map((event) => event.type)).toEqual(['resized', 'exit'])
    expect(seen[0]).toMatchObject({ type: 'resized', cols: 200, rows: 87 })
    // 事件**只**投递给观察者，不回填进任何本地尺寸记录：owner 随后说 null，投影就得是 null。
    // 这一条是删掉那本台账的守卫——谁再把 `resized` 记进一张 Map 并让 projectRun 读它，这里立刻红。
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: null, rows: null })
    await observation.close()
  })
})

/**
 * 上面那些 `resized` / `current_size` 用例喂的都是**合成**事件与快照。它们证明 handler 写对了，
 * 证明不了 daemon 发得出来。这一条把「发得出来」钉在**产物**上：换代即红。
 *
 * protocol 16 起 `current_size` 是 RunInfo 上的**必填**字段（Rust 侧没有 `skip_serializing_if`），
 * 所以每张快照都给出答案，`null` 是「没有 owner 能确认」这个真答案，不是「字段缺席」。adapter 因此
 * 删掉了那本只记录**我们自己**发起的 resize 的本地台账——daemon 的答案在每条路径上都先到。
 */
describe('vendored ctxmux 的协议现状', () => {
  it('是 protocol 17：current_size 与 resized 都已在场', () => {
    // 用 SDK 导出的常量，而不是 grep 生成物的 .d.ts：常量是 SDK 的公开契约，随 tarball 一起被
    // pnpm-lock 的 integrity 钉住；grep 要写死一条 node_modules/.pnpm 路径，路径一变就**静默**
    // 变成读不到文件或恒真断言——那正是这条用例要防的东西。
    expect(PROTOCOL_VERSION).toBe(17)
  })

  it('current_size 是必填字段——台账被删掉正是靠这一条', () => {
    // 类型层判据，不是运行时的：一个值上「字段缺席」根本无从运行时区分于「值是 undefined」，而承重
    // 的性质恰恰是**类型**上不允许缺席。若上游把它改回 `current_size?:`，`undefined` 就进了这个联合，
    // RequiredCurrentSize 塌成 never，下面这行赋值立刻是 tsc 错误——而不是一条静默照绿的运行时断言。
    type RequiredCurrentSize = undefined extends RunInfo['current_size'] ? never : true
    const currentSizeIsRequired: RequiredCurrentSize = true
    expect(currentSizeIsRequired).toBe(true)
  })
})
