import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type RunEvent } from '@ctxmux/sdk'
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

function runInfo(currentSize: { cols: number; rows: number } | null): unknown {
  return {
    id: 'resize-run',
    spec: {
      program: 'codex',
      args: [],
      cwd: '/tmp/resize-run',
      env: {},
      size: { cols: 80, rows: 24 }
    },
    lineage: null,
    backend: { type: 'native' },
    capabilities: {},
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

  it('current_size 显式为 null 时，连自己刚记下的 applied size 都不许顶上', async () => {
    // 上一条用的是**全新 adapter**，`confirmedSizes` 是空的——于是 `=== undefined` 与 `!snapshot`
    // 两种判据给出同一个 null，那条断言对这个分支是空转的（实测：把 `snapshot === undefined` 改成
    // `!snapshot`，5/5 全绿）。判别力只在「缓存里**有**东西」时才出现，所以这里先真做一次 resize
    // 把 applied size 记进 confirmedSizes，再让 owner 报 null。
    //
    // 契约是两件不同的事必须分开：字段**缺席**（老快照没这个字段）可以回退到我们记下的 applied
    // size；字段**显式为 null**是 owner 在说「我现在也不知道」——那就得如实是 unknown。拿一个陈旧的
    // 缓存值去冒充「当前尺寸」，比承认不知道更糟：它看起来是权威事实，而屏幕证据会按这个错尺寸重建。
    const adapter = adapterWith({ currentSize: { cols: 80, rows: 24 }, appliedSize: { cols: 200, rows: 87 } })
    await adapter.resize('resize-run', 200, 90)
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: 200, rows: 87 })

    ;(adapter as unknown as { client: { status: () => Promise<unknown> } }).client.status =
      async () => runInfo(null)
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: null, rows: null })
  })

  it('没有 current_size 字段时，也不用 spec.size 冒充当前尺寸', async () => {
    const adapter = new CtxmuxRunAdapter()
    const snapshot = {
      id: 'resize-run',
      spec: {
        program: 'codex',
        args: [],
        cwd: '/tmp/resize-run',
        env: {},
        size: { cols: 80, rows: 24 }
      },
      lineage: null,
      backend: { type: 'native' },
      capabilities: {},
      pid: 4321,
      state: { type: 'running' },
      latest_output_bytes: 0,
      durable_output_bytes: 0,
      first_available_byte: 0,
      attachments: 1,
      applied_input_bytes: 0
    }
    ;(adapter as unknown as { client: unknown }).client = {
      status: async () => snapshot,
      list: async () => [snapshot]
    }
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
  it('observeOutput 把 Resized 投递给观察者，并记下 applied size', async () => {
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
      status: async () => ({
        id: 'resize-run',
        spec: {
          program: 'codex',
          args: [],
          cwd: '/tmp/resize-run',
          env: {},
          size: { cols: 80, rows: 24 }
        },
        lineage: null,
        backend: { type: 'native' },
        capabilities: {},
        pid: 4321,
        state: { type: 'running' },
        latest_output_bytes: 0,
        durable_output_bytes: 0,
        first_available_byte: 0,
        attachments: 1,
        applied_input_bytes: 0
      })
    }

    const observation = await adapter.observeOutput('resize-run', 0, (event) => seen.push(event))
    expect(observation.run).toMatchObject({ cols: 80, rows: 24 })
    for (let attempt = 0; attempt < 50 && seen.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(seen.map((event) => event.type)).toEqual(['resized', 'exit'])
    expect(seen[0]).toMatchObject({ type: 'resized', cols: 200, rows: 87 })
    // Live Resized fills the observation cache used when a later snapshot omits current_size.
    await expect(adapter.status('resize-run')).resolves.toMatchObject({ cols: 200, rows: 87 })
    await observation.close()
  })
})

/**
 * 上面那些 `resized` / `current_size` 用例喂的都是**合成**事件与快照。它们证明 handler 写对了，
 * 证明不了 daemon 发得出来——而今天它发不出来：vendored artifact 是 ctxmux `c13ab114`、protocol 14，
 * 其 SDK 既没有 `RunInfo.current_size` 也没有 `resized` 变体。所以真正在跑的只有 resize receipt 的
 * `applied_size` 那条路，跨客户端的 resize 收不到。
 *
 * 这一条把那个事实钉在**产物**上而不是注释里：重新 vendor 到带这两个字段的版本时它会变红，提示去
 * 掉 adapter 里的 cast、把 `docs/architecture/terminal-runtime.md` 那行 caveat 删掉，并确认跨客户端
 * resize 真的通了。红的时候不是缺陷，是"前提变了，来收尾"。
 */
describe('vendored ctxmux 的协议现状', () => {
  it('仍是 protocol 14：current_size 与 resized 尚未存在，cast 与 caveat 都还需要', () => {
    // 用 SDK 导出的常量，而不是 grep 生成物的 .d.ts：常量是 SDK 的公开契约，随 tarball 一起被
    // pnpm-lock 的 integrity 钉住；grep 要写死一条 node_modules/.pnpm 路径，路径一变就**静默**
    // 变成读不到文件或恒真断言——那正是这条用例要防的东西。
    expect(PROTOCOL_VERSION).toBe(14)
  })
})
