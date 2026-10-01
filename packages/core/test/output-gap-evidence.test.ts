import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachmentView } from '../src/types.js'

// Only the SDK transport is a deterministic fixture. The public Adapter attach/pump, Core
// producer and public event subscription are real; this test never connects to a daemon.
async function fixture(view: AgentMuxRunAttachmentView, publishedByte: number) {
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const inner = core as unknown as {
    kernel: CtxmuxRunAdapter
    acceptKernelEvent: Parameters<CtxmuxRunAdapter['onEvent']>[0]
  }
  const seen: AgentMuxClientEvent[] = []
  const unsubscribe = core.onEvent(event => seen.push(event))
  const unsubscribeKernel = inner.kernel.onEvent(event => inner.acceptKernelEvent(event))
  let finish: (() => void) | undefined
  const closed = new Promise<void>(resolve => { finish = resolve })
  const attachment = {
    snapshot: {
      run: { id: 'gap-run', spec: null, pid: 123, state: { type: 'running' },
        latest_output_bytes: 0, first_available_byte: 0, applied_input_bytes: null, current_size: null },
      replay: { chunks: [], first_available_byte: 0, latest_output_bytes: 0, truncated: false },
      terminal: { type: 'not_requested' }, resize_revision: 0
    },
    async *events() {
      if (publishedByte > 0) yield { type: 'output', chunk: {
        start_byte: 0, end_byte: publishedByte, data: new Uint8Array(publishedByte).fill(65)
      } }
      yield { type: 'gap', latest_output_bytes: 27 }
      await closed
    },
    detach: async () => finish?.(), close: () => finish?.()
  }
  const sdk = { attach: vi.fn(async () => attachment), attachTerminal: vi.fn(async () => attachment) }
  ;(inner.kernel as unknown as { client: unknown }).client = sdk
  try {
    await inner.kernel.attach('gap-run', 0, undefined, view)
    await vi.waitFor(() => expect(seen.filter(event => event.type === 'agent-error')).toHaveLength(1))
    return { core, inner, seen, sdk }
  } finally {
    await inner.kernel.detach('gap-run')
    unsubscribeKernel(); unsubscribe(); inner.kernel.disconnect()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the existing Gap producer retains this observation without claiming delivery', () => {
  it.each(['raw', 'terminal'] as const)('public %s Attachment pump retains its actual publication cursor', async view => {
    vi.spyOn(Date, 'now').mockReturnValue(12345)
    const { seen, sdk } = await fixture(view, 4)
    const gaps = seen.filter(event => event.type === 'agent-error')
    expect(gaps).toEqual([{
      type: 'agent-error', code: 'OUTPUT_GAP',
      message: 'This Attachment did not receive a continuous output stream.',
      evidence: { source: 'terminal-output', observedAt: 12345, run: { runId: 'gap-run' },
        outputGap: { kind: 'live-stream', latestOutputBytes: 27, publishedThroughByte: 4, representation: view } }
    }])
    expect(sdk.attach).toHaveBeenCalledTimes(view === 'raw' ? 1 : 0)
    expect(sdk.attachTerminal).toHaveBeenCalledTimes(view === 'terminal' ? 1 : 0)
  })

  it('preserves a genuinely owned zero cursor rather than calling it unknown', async () => {
    const { seen } = await fixture('raw', 0)
    expect(seen.filter(event => event.type === 'agent-error')).toMatchObject([
      { evidence: { outputGap: { kind: 'live-stream', publishedThroughByte: 0, representation: 'raw' } } }
    ])
  })

  it('has no publication or representation fact when this Core owns no Attachment', () => {
    const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const seen: AgentMuxClientEvent[] = []
    const unsubscribe = core.onEvent(event => seen.push(event))
    const inner = core as unknown as { acceptKernelEvent(event: unknown): void }
    try { inner.acceptKernelEvent({ type: 'gap', runId: 'unowned-run', latestOutputBytes: 31 }) }
    finally { unsubscribe() }
    expect(seen).toMatchObject([{
      type: 'agent-error', evidence: { run: { runId: 'unowned-run' },
        outputGap: { kind: 'live-stream', latestOutputBytes: 31, publishedThroughByte: null, representation: null } }
    }])
    expect(seen).toHaveLength(1)
  })
})
