// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { grokChunk, grokDone, grokUpdate, grokUser } from '../../core/test/fixtures/grok-updates.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { consumeConversationWindowPage, type ConversationWindowSnapshot } from '../../core/src/conversation-changes.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
import { projectConversationWindow } from '../src/lib/conversation-records.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const nativeSessionId = 'native-main'
const promptId = 'original-prompt'
const progress = '先检查原生消息的来源与阶段，再验证对话中的进度是否完整可读。'
const final = '已完成核对。公开进度和最终回复分别保留，工具过程可以独立展开。'
const privateThought = 'private reasoning canary'
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
const at = new Date(60_000).toISOString()

function rows(provider: 'claude' | 'grok' | 'codex', cwd = '.') {
  if (provider === 'claude') {
    const message = (uuid: string, content: unknown[], stop_reason: string) => ({ uuid, type: 'assistant', sessionId: nativeSessionId,
      user_message_uuid: promptId, timestamp: at, message: { id: uuid, role: 'assistant', stop_reason, content } })
    return { initial: [
      { uuid: promptId, type: 'user', sessionId: nativeSessionId, timestamp: at, message: { role: 'user', content: '请检查对话模式的进度消息。' } },
      message('progress', [{ type: 'text', text: progress }], 'tool_use'),
      message('tool', [{ type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'README.md' } }], 'tool_use'),
      message('thought', [{ type: 'thinking', thinking: privateThought }], 'tool_use')
    ], ending: [message('final', [{ type: 'text', text: final }], 'end_turn')] }
  }
  if (provider === 'grok') return { initial: [grokUser(nativeSessionId, '请检查对话模式的进度消息。', promptId),
    grokChunk(nativeSessionId, progress.slice(0, 12), promptId),
    grokUpdate(nativeSessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'chat' }, promptId),
    grokChunk(nativeSessionId, progress.slice(12), promptId),
    grokUpdate(nativeSessionId, { sessionUpdate: 'tool_call', toolCallId: 'read-call', title: 'Read', rawInput: { path: 'README.md' } }, promptId),
    grokUpdate(nativeSessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: privateThought } }, promptId)
  ], ending: [grokChunk(nativeSessionId, final.slice(0, 8), promptId), grokChunk(nativeSessionId, final.slice(8), promptId), grokDone(nativeSessionId, promptId)] }
  const item = (payload: Record<string, unknown>) => ({ timestamp: at, type: 'response_item', payload })
  return { initial: [{ type: 'session_meta', payload: { id: nativeSessionId, cwd } },
    item({ id: promptId, type: 'message', role: 'user', content: [{ type: 'input_text', text: '请检查对话模式的进度消息。' }] }),
    item({ id: 'progress', type: 'message', role: 'assistant', phase: 'commentary', turn_id: promptId, content: [{ type: 'output_text', text: progress }] }),
    item({ id: 'tool', type: 'function_call', name: 'read_file', call_id: 'read-call', arguments: '{"path":"README.md"}' }),
    item({ id: 'thought', type: 'reasoning', summary: [{ type: 'summary_text', text: privateThought }] })
  ], ending: [item({ id: 'final', type: 'message', role: 'assistant', phase: 'final_answer', turn_id: promptId, content: [{ type: 'output_text', text: final }] })] }
}

it.each(['claude', 'grok', 'codex'] as const)('%s public progress survives actual RPC/CLI and remains outside collapsed process through final append', async provider => {
  const data = rows(provider)
  const f = await nativeHistoryFixture(provider, root => jsonl(rows(provider, root).initial), { relativePath: provider === 'grok' ? 'updates.jsonl' : 'native.jsonl' })
  if (provider === 'grok') await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id: nativeSessionId, cwd: f.root } }))
  const socketPath = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element), copies = vi.fn(async () => true)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const render = async (snapshot: ConversationWindowSnapshot) => {
    const reading = projectConversationWindow(snapshot)
    await act(async () => root.render(<ClientUiProvider platform={{ ...platform, copyText: copies }}>
      <ConversationView sessionId={ref.agentSessionId} executionHostId={ref.hostId} page={reading.historyPage}
        timeline={reading.captured} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage}
        renderProcess={props => <NativeProcessObservation {...props} compact />} />
    </ClientUiProvider>))
    return reading
  }
  try {
    const opened = await rpc.call('agent.conversation.inspect', { ...ref, limit: 100 })
    const accepted = consumeConversationWindowPage(opened)
    expect(accepted.kind).toBe('complete')
    if (accepted.kind !== 'complete') throw Error('Small native fixture requires a complete original window')
    const reading = await render(accepted.snapshot)
    const messages = reading.records.filter(record => record.original.kind === 'native' && record.original.item.messagePhase === 'progress')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe(progress)
    const visible = element.querySelector('[data-message-phase="progress"]')!
    expect(visible).not.toBeNull(); expect(visible.textContent).toContain(progress)
    expect(visible.closest('[hidden], [inert]')).toBeNull()
    expect(element.querySelector('.native-process-observation .wf-head[aria-expanded="false"]')).not.toBeNull()
    expect(element.textContent).not.toContain(privateThought)
    let cli!: Awaited<ReturnType<typeof runCompiledObjectCli>>
    await act(async () => {
      cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'conversation', 'inspect', '--host', 'local',
        '--session', ref.agentSessionId, '--limit', '100'], objectCliEnvironment(f.root), '', 30_000)
    })
    expect(cli.code, cli.stderr).toBe(0)
    const cliAccepted = consumeConversationWindowPage(JSON.parse(cli.stdout).result)
    expect(cliAccepted.kind).toBe('complete')
    if (cliAccepted.kind !== 'complete') throw Error('CLI must carry the complete source window')
    expect(projectConversationWindow(cliAccepted.snapshot).records.filter(record => record.original.kind === 'native' && record.original.item.messagePhase === 'progress')
      .map(record => ({ id: record.rawId, content: record.content }))).toEqual([{ id: messages[0]!.rawId, content: progress }])

    await appendFile(f.path, jsonl(data.ending))
    const changed = await rpc.call('agent.conversation.changes', { ...ref, checkpoint: opened.window.checkpoint, view: opened.window.view!, limit: 100 })
    const complete = consumeConversationWindowPage(changed)
    expect(complete.kind).toBe('complete')
    if (complete.kind !== 'complete') throw Error('Final append requires a complete replacement')
    const after = await render(complete.snapshot)
    const speech = after.records.filter(record => record.original.kind === 'native' && record.original.item.kind === 'assistant-message')
    expect(speech.map(record => record.content)).toEqual([progress, final])
    expect(speech[0]!.id).toBe(messages[0]!.id)
    expect(speech.map(record => record.original.kind === 'native' ? record.original.item.messagePhase : null)).toEqual(['progress', 'final'])
    expect(element.querySelectorAll('[data-message-phase="progress"]')).toHaveLength(1)
    expect(element.querySelectorAll('[data-message-phase="final"]')).toHaveLength(1)
    expect(element.querySelector('[data-message-phase="final"]')!.textContent).toContain(final)
    expect(element.textContent).not.toContain(privateThought)
    const exact = await rpc.call('agent.conversation.inspect', { ...ref, record: messages[0]!.records![0]!.reference! })
    const detail = consumeConversationWindowPage(exact)
    expect(detail.kind).toBe('complete')
    if (detail.kind !== 'complete') throw Error('Original progress detail must remain readable')
    const exactRecords = projectConversationWindow(detail.snapshot).records
    expect(exactRecords.map(record => record.content)).toEqual([progress])
    expect(exactRecords[0]!.rawId).toBe(messages[0]!.rawId)
    expect(exactRecords[0]!.records![0]!.reference).toEqual(messages[0]!.records![0]!.reference)

    if (process.env.AGENTMUX_PROGRESS_VISUAL) {
      await mkdir(process.env.AGENTMUX_PROGRESS_VISUAL, { recursive: true })
      await writeFile(join(process.env.AGENTMUX_PROGRESS_VISUAL, `${provider}.json`), JSON.stringify(complete.snapshot, null, 2) + '\n')
    }
    expect(await f.store.readMetadata(ref.agentSessionId)).toEqual(f.session)
    expect(await readFile(f.path, 'utf8')).toBe(f.before.native.toString('utf8') + jsonl(data.ending))
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    await act(async () => element.querySelector<HTMLButtonElement>('[data-message-phase="progress"] [aria-label="Copy message"]')!.click())
    expect(copies).toHaveBeenLastCalledWith(progress, expect.any(Function))
  } finally {
    await act(async () => root.unmount()); element.remove(); rpc.dispose()
    await server.stop(); await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  }
}, 60_000)
