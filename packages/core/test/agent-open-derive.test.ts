import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { composeAgentDerivedAction } from '../src/agent-derived-actions.js'
import { spatialAgentFact } from '../src/spatial-agent-open-contract.js'
import type { AgentMuxControlRequest } from '../src/control.js'

const native = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-original', transcriptPath: '/fixture/original.jsonl' }
const source = { agentSessionId: 'original-session', hostId: 'local', run: { runId: 'original-run' }, providerId: 'claude', executorId: 'claude',
  workspacePath: '/fixture/repo', nativeHandle: native }
const actions: Record<string, Record<string, unknown>> = {
  review: { label: 'Review this work', base: 'new-agent', instruction: 'Review the changes and list concrete bugs.', executorId: 'codex' },
  retry: { label: 'Try another approach', base: 'fork', instruction: 'Try a different design.' },
  ask: { label: 'Explain', base: 'new-agent', instruction: 'Explain the work in plain words.' }
}
const destination = ['--space', 'space', '--zone', 'zone', '--new-tab']
const created = { agentSessionId: 'derived-session', run: { runId: 'derived-run' }, providerId: 'codex', executorId: 'codex', workspacePath: source.workspacePath }

async function harness() {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'amx-derive-'))
  const opened: Array<Extract<AgentMuxControlRequest, { operation: 'agent.open' }>> = []
  const client = { readAgentSession: async (id: string) => id === source.agentSessionId ? structuredClone(source) : null,
    agentSession: (id: string) => { if (id !== source.agentSessionId) throw Object.assign(new Error('unknown'), { code: 'UNKNOWN_AGENT_SESSION' }); return structuredClone(source) },
    readAgentSessions: async () => [structuredClone(source)], sessionHistorySources: async () => [] }
  const spatialState = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await spatialState.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'folder', hostId: 'local', directoryPath: source.workspacePath, projectId: 'project', name: 'Original Project' }],
    zones: [
      { zoneId: 'zone', workspaceId: 'workspace', kind: 'home', hostId: 'local', directoryPath: source.workspacePath, branch: null },
      { zoneId: 'wrong-zone', workspaceId: 'wrong-workspace', kind: 'worktree', hostId: 'local', directoryPath: '/fixture/other', branch: 'other' }
    ],
    bindings: [{ spaceId: 'space', zoneId: 'zone' }, { spaceId: 'space', zoneId: 'wrong-zone' }],
    tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  } })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [{ hostId: 'local', client: client as never }], spatialState,
    execute: async request => {
      if (request.operation === 'settings.resource.get' && request.resource === 'derived-actions') {
        const value = request.id !== undefined ? actions[request.id] : undefined
        if (!value) throw Object.assign(new Error(`Derived action “${request.id}” does not exist.`), { code: 'SETTING_RESOURCE_NOT_FOUND' })
        return { operation: request.operation, resource: 'derived-actions', item: { id: request.id!, value } }
      }
      if (request.operation !== 'agent.open') throw new Error(`Unexpected ${request.operation}`)
      opened.push(request)
      const content = request.content
      const session = content.kind === 'fork-agent' ? { ...created, providerId: 'claude', executorId: 'claude', forkedFrom: content.source }
        : { ...created, executorId: content.kind === 'new-agent' ? content.executorId : created.executorId }
      return { operation: 'agent.open', requestId: request.requestId, outcome: 'opened', from: null, to: null, agent: spatialAgentFact(session as never, 'local'), resource: null,
        save: { layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }, issues: [] }
    } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const open = async (...args: string[]) => rpc.call('agent.open', (await parseAgentMuxCliInvocation(['agent', 'open', ...args, ...destination])).params as never)
  return { opened, open, openWrong: async () => rpc.call('agent.open', (await parseAgentMuxCliInvocation(['agent', 'open', '--derive', 'review', '--from-session', source.agentSessionId,
    '--space', 'space', '--zone', 'wrong-zone', '--new-tab'])).params as never), close: async () => { await rpc.dispose(); await server.stop(); await rm(root, { recursive: true, force: true }) } }
}

describe('agent open --derive', () => {
  it('parses one exact shorthand and refuses mixed or resource-creating forms', async () => {
    const invocation = await parseAgentMuxCliInvocation(['agent', 'open', '--derive', 'review', '--from-session', 'original-session', '--operation-id', 'derive-once', ...destination])
    expect(invocation.params).toEqual({ operationId: 'derive-once', content: { kind: 'derived-action', actionId: 'review', source: { agentSessionId: 'original-session' } },
      destination: { spaceId: 'space', zoneId: 'zone', newTab: true }, focus: false })
    for (const extra of [['--prompt', 'x'], ['--session', 's'], ['--fork-from', 's'], ['--new-zone']]) {
      await expect(parseAgentMuxCliInvocation(['agent', 'open', '--derive', 'review', '--from-session', 'original-session', ...extra, ...destination])).rejects.toThrow()
    }
    await expect(parseAgentMuxCliInvocation(['agent', 'open', '--derive', 'review', ...destination])).rejects.toThrow()
    await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'codex', '--from-session', 'original-session', ...destination])).rejects.toThrow('--from-session requires --derive')
    expect(agentMuxCommandHelp('agent.open')).toContain('--derive ACTION --from-session')
    expect(agentMuxCommandHelp('settings.derived-actions')).toContain('settings derived-actions ls')
  })

  it('expands a saved new-agent action with the same Core prompt the App sends, and a fork action into a native fork', async () => {
    const h = await harness()
    try {
      await h.open('--derive', 'review', '--from-session', 'original-session', '--operation-id', 'derive-review')
      expect(h.opened[0]).toMatchObject({ requestId: 'derive-review', content: { kind: 'new-agent', executorId: 'codex' }, destination: { spaceId: 'space', zoneId: 'zone', newTab: true } })
      expect(h.opened[0]!.content).toEqual({ kind: 'new-agent', executorId: 'codex',
        prompt: composeAgentDerivedAction({ instruction: actions.review!.instruction as string },
          { hostId: 'local', agentSessionId: source.agentSessionId, executorId: source.executorId }) })
      await expect(h.openWrong()).rejects.toMatchObject({ code: 'SPACE_RESOURCE_CHANGED' })
      expect(h.opened).toHaveLength(1)
      // An explicit --executor wins over the action's default Agent.
      await h.open('--derive', 'review', '--from-session', 'original-session', '--executor', 'claude')
      expect(h.opened.at(-1)!.content).toMatchObject({ kind: 'new-agent', executorId: 'claude' })
      await h.open('--derive', 'ask', '--from-session', 'original-session', '--executor', 'claude')
      expect(h.opened[2]!.content).toMatchObject({ kind: 'new-agent', executorId: 'claude' })
      await h.open('--derive', 'retry', '--from-session', 'original-session')
      expect(h.opened[3]!.content).toEqual({ kind: 'fork-agent', source: { agentSessionId: 'original-session', expectedRun: source.run, expectedNativeHandle: native }, prompt: 'Try a different design.' })
    } finally { await h.close() }
  })

  it('names what is missing and starts nothing', async () => {
    const h = await harness()
    try {
      await expect(h.open('--derive', 'ask', '--from-session', 'original-session')).rejects.toThrow(/--executor/)
      await expect(h.open('--derive', 'retry', '--from-session', 'original-session', '--executor', 'codex')).rejects.toThrow(/remove --executor/)
      await expect(h.open('--derive', 'take-over', '--from-session', 'original-session', '--executor', 'codex')).rejects.toThrow(/official action/)
      await expect(h.open('--derive', 'missing', '--from-session', 'original-session', '--executor', 'codex')).rejects.toThrow()
      await expect(h.open('--derive', 'review', '--from-session', 'not-a-session')).rejects.toThrow()
      expect(h.opened).toHaveLength(0)
    } finally { await h.close() }
  })
})
