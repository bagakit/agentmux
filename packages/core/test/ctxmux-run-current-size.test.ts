import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@ctxmux/sdk'
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

