// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { paginatedFixture, user, context, body, source } from '../../core/test/helpers/codex-paginated.js'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { StaticConversationView as ConversationView } from '../../../apps/desktop/test/helpers/conversation-static-fixture'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }

it('compiled Provider through actual public RPC and CLI reaches the shared consumer as one native user and retained model context', async () => {
  const f = await paginatedFixture([context(), user()], 'paginated', true)
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
  try {
    const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, input = { ...ref, source: 'native' as const, limit: 100 }
    const page = await f.client.sessionHistoryPage(ref.agentSessionId)
    const history = await rpc.call('agent.history', input)
    const items = history.items.flatMap(entry => entry.kind === 'item' && 'contentParts' in entry.item ? [entry.item] : [])
    expect(history.nativeSource).toEqual(source); expect(items).toEqual(page.items); expect(items).toHaveLength(2)
    const actualUnits = []
    let cursor: string | undefined
    for (let n = 0; n < 10; n++) {
      const units = await rpc.call('agent.conversation.inspect', { ...ref, limit: 10, ...(cursor ? { cursor } : {}) })
      actualUnits.push(...units.items)
      if (!units.nextCursor) break
      expect(units.nextCursor).not.toBe(cursor); cursor = units.nextCursor
    }
    expect(actualUnits).toHaveLength(2)
    expect(actualUnits.flatMap(entry => entry.kind === 'item' ? [{ role: entry.item.event.role, raw: entry.item.records[0]!.reference!.source.recordId }] : []))
      .toEqual([{ role: 'message', raw: f.recordId(1) }, { role: 'process', raw: 'model-context-record' }])
    const query = await rpc.call('agent.history', { ...input, kind: 'user-message', scanLimit: 10 })
    expect(query.userMessages).toHaveLength(1); expect(query.userMessages![0]).toMatchObject({ rawId: f.recordId(1), content: body, publicContent: 'unknown' })
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'history', '--host', 'local', '--session', ref.agentSessionId, '--source', 'native', '--kind', 'user-message', '--scan-limit', '10'], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.userMessages).toEqual(query.userMessages)
    const copy = vi.fn(async () => true)
    await act(async () => root.render(<ClientUiProvider platform={{ ...platform, copyText: copy }}><ConversationView page={{ ...page, items }}
      sessionId={ref.agentSessionId} executionHostId="local" renderProcess={props => <NativeProcessObservation {...props} compact />} /></ClientUiProvider>))
    const userRows = host.querySelectorAll('[data-speaker-role="human"]')
    expect(userRows).toHaveLength(1); expect(userRows[0]!.textContent).toContain('Original user text 中🙂')
    await act(async () => (userRows[0]!.querySelector('[aria-label="Copy message"]') as HTMLButtonElement).click())
    expect(copy).toHaveBeenLastCalledWith(body, expect.any(Function))
    expect(host.querySelector(`[data-native-record-id="${f.recordId(1)}"]`)).not.toBeNull()
    const disclosure = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')
    expect(disclosure).not.toBeNull()
    await act(async () => disclosure!.click())
    const original = host.querySelector('[data-native-record-id="model-context-record"]')
    expect(original).not.toBeNull()
    await act(async () => original!.querySelector<HTMLButtonElement>('.wf-native-process button[aria-expanded]')!.click())
    expect(original!.textContent).toContain('Original user text 中🙂')
    expect(original!.querySelector('[data-speaker-role="human"]')).toBeNull()
    expect(host.querySelectorAll('[data-speaker-role="human"]')).toHaveLength(1)
    await f.unchangedSource()
  } finally {
    await act(async () => root.unmount()); host.remove(); rpc.dispose(); await server.stop(); await f.close(); vi.unstubAllEnvs()
  }
}, 30_000)
