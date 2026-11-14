// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { LocalRetainedInputsPanel } from '../src/renderer/src/components/LocalRetainedInputs'
import { SessionRecordDetails } from '../src/renderer/src/components/SessionRecordDetails'
import { api } from '../src/renderer/src/lib/api'
import { desktopUserDocument } from '../src/renderer/src/lib/desktop-user-state'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const agent = composerSession()
const originalText = 'Exact original archived message\n\nPrior authored paragraph 中🙂'
const operationId = 'confirmed-original'

function archiveEntry(id = operationId, text = originalText, hostId = agent.hostId): AgentSteerQueueEntry {
  const run = agent.control.run, key = { kind: 'prompt' as const, agentSessionId: agent.id, expectedRun: run, submissionId: id }
  const ref = { key, waitGeneration: 1 }
  return { operationId: id, text, archived: true, status: 'deferred', runId: run.runId, enqueuedAt: 20,
    directInputControl: { ...agent.control, hostId }, directInputBinding: { expectedRun: run, admissionIntent: { kind: 'manual-actor' } },
    inputReceipt: { key, ref, status: 'terminal-confirmed', persistence: 'confirmed', observation: 'closed', admission: null,
      control: { ref, state: 'dispatch-authorized', gateId: 'original-gate', at: 21 } } }
}

function saved(entry = archiveEntry(), ownerKey = agent.id) { return { ownerKey, entry } }
function sourceTarget(runtimeId: string): SpaceMountMemberTarget {
  return { hostId: 'foreign-route', target: { runtimeId, agentSessionId: agent.id, regionId: 'foreign-region',
    expectedRun: agent.control.run, reference: { runtimeId, spaceId: 'foreign-space' } } }
}
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const archiveRow = (id = operationId) => panel().querySelector<HTMLElement>(`li[data-operation-id="${id}"]`)
const localRecords = () => [...document.querySelectorAll<HTMLDetailsElement>('.local-input-record')]

async function openMailbox() {
  for (const type of ['beforetoggle', 'toggle']) {
    const event = new Event(type); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => panel().dispatchEvent(event))
  }
}
async function click(button: Element | null) {
  expect(button?.tagName).toBe('BUTTON')
  await act(async () => (button as HTMLButtonElement).click())
}
async function disclose(details: HTMLDetailsElement) {
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle', { bubbles: true })) })
}

it('the mounted Composer reads one archive page on Inputs and keeps the original detail through read failure', async () => {
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive')
    .mockResolvedValueOnce({ entries: [saved()], nextCursor: 'earlier-window' })
    .mockRejectedValueOnce(new Error('Saved archive temporarily unavailable'))
    .mockResolvedValueOnce({ entries: [saved()], nextCursor: 'earlier-window' })
    .mockResolvedValueOnce({ entries: [saved(archiveEntry('earlier-input', 'An earlier original input'))], nextCursor: null })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  const { inputReceipt: _receipt, ...savedUnknown } = archiveEntry('unknown-input', 'Original uncertain input')
  const unknown = { ...savedUnknown, inputIntakeStarted: true as const }
  await dom.render(<AgentSessionComposer sessionId={agent.id} />)
  expect(read).not.toHaveBeenCalled()
  await openMailbox()
  await dom.click('[role="tab"][id$="-agents-tab"]')
  expect(read).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ agentSteerQueues: { [agent.id]: [unknown] } }))
  await dom.click('[role="tab"][id$="-user-tab"]')
  expect(read).toHaveBeenCalledExactlyOnceWith({ ownerKey: agent.id, limit: 30 })
  expect(archiveRow()).not.toBeNull()
  expect(archiveRow()!.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')?.disabled).toBe(true)
  expect(archiveRow('unknown-input')!.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')?.disabled).toBe(false)
  await click(archiveRow()!.querySelector('.composer-mailbox__row'))
  expect(archiveRow()!.querySelector('.log-turn__body')?.textContent).toContain('Prior authored paragraph 中🙂')
  await click(archiveRow()!.querySelector('[aria-label="Copy message"]'))
  expect(copy).toHaveBeenLastCalledWith(originalText)

  await click(panel().querySelector('[aria-label="Refresh inputs"]'))
  expect(panel().textContent).toContain('Saved archive temporarily unavailable')
  expect(archiveRow()!.querySelector('.log-turn__body')?.textContent).toContain('Prior authored paragraph 中🙂')
  await click(panel().querySelector('[aria-label="Retry saved inputs"]'))
  await click([...panel().querySelectorAll('button')].find(button => button.textContent === 'Load earlier saved inputs') ?? null)
  expect(read).toHaveBeenLastCalledWith({ ownerKey: agent.id, limit: 30, after: 'earlier-window' })
  expect(archiveRow('earlier-input')?.textContent).toContain('An earlier original input')
  expect(useAppStore.getState().agentSteerQueues[agent.id]).toEqual([unknown])
  expect(dom.draft()).toBe('Keep my draft')
  expect(submit).not.toHaveBeenCalled()
})

it('an original Source Composer sharing the local SID keeps its Runtime key and ignores a late local page', async () => {
  const runtimeId = 'exact-foreign-runtime'
  const ownerKey = originalSourceInputOwnerKey(runtimeId, agent.id)
  let resolveLocal!: (page: Awaited<ReturnType<typeof api.ui.readWorkbenchInputArchive>>) => void
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockImplementation(query => query.ownerKey === ownerKey
    ? Promise.resolve({ entries: [], nextCursor: null })
    : new Promise(resolve => { resolveLocal = resolve }))
  await dom.render(<AgentSessionComposer sessionId={agent.id} />)
  await openMailbox()
  await dom.click('[role="tab"][id$="-user-tab"]')
  await dom.render(<AgentSessionComposer sessionId={agent.id} ownerKey={ownerKey} readOnly source={{ target: sourceTarget(runtimeId) }} />)
  expect(read.mock.calls).toEqual([[{ ownerKey: agent.id, limit: 30 }], [{ ownerKey, limit: 30 }]])
  await act(async () => resolveLocal({ entries: [saved()], nextCursor: null }))
  expect(panel().textContent).not.toContain(originalText)
  expect(archiveRow()).toBeNull()
})

it('archive commit refresh is scoped to the open original owner', async () => {
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockResolvedValue({ entries: [saved()], nextCursor: null })
  let commit!: (owners: ReadonlySet<string> | null) => void
  const release = vi.fn()
  vi.spyOn(desktopUserDocument, 'subscribeInputQueueCommits').mockImplementation(listener => { commit = listener; return release })
  await dom.render(<AgentSessionComposer sessionId={agent.id} />)
  await openMailbox()
  await dom.click('[role="tab"][id$="-user-tab"]')
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => commit(new Set(['different-owner'])))
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => commit(new Set([agent.id])))
  expect(read).toHaveBeenCalledTimes(2)
  await dom.click('[role="tab"][id$="-agents-tab"]')
  expect(release).toHaveBeenCalledOnce()
  await act(async () => commit(new Set([agent.id])))
  expect(read).toHaveBeenCalledTimes(2)
})

it('GlobalSystemNotices keeps reporting a hot original delivery issue without reading cold inputs', async () => {
  const { archived: _archived, inputReceipt: _receipt, ...original } = archiveEntry('active-unknown', 'Unconfirmed original input')
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive')
  useAppStore.setState({ agentSteerQueues: { [agent.id]: [{ ...original,
    inputIntakeStarted: true, promptCondition: { expectedRun: agent.control.run, afterSubmissionId: null } }] } })
  await dom.render(<GlobalSystemNotices />)
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.global-system-notices__details')!.dispatchEvent(event))
  await dom.click('[role="tab"][data-section="current"]')
  expect(dom.container.textContent).toContain('The original message delivery is still unconfirmed')
  expect(read).not.toHaveBeenCalled()
})

it('Focus opens the global cold archive for copying without an active Session', async () => {
  useAppStore.setState({ sessions: [] })
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockResolvedValue({ entries: [saved()], nextCursor: null })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const send = vi.spyOn(api.sessions, 'submitPrompt'), reopen = vi.spyOn(api.sessions, 'reopen')
  await dom.render(<LocalRetainedInputsPanel />)
  expect(read).not.toHaveBeenCalled()
  await dom.click('[aria-label="Drafts & queue"]')
  expect(read).toHaveBeenCalledExactlyOnceWith({ limit: 30 })
  const row = localRecords().find(item => item.textContent?.includes('Exact original archived message'))!
  expect(row).toBeDefined()
  await disclose(row)
  expect(row.textContent).toContain('Saved stateArchived')
  expect(row.textContent).toContain('Delivery receiptTerminal input confirmed')
  await click([...row.querySelectorAll('button')].find(button => button.textContent === 'Copy saved input') ?? null)
  expect(copy).toHaveBeenCalledExactlyOnceWith(originalText)
  expect(send).not.toHaveBeenCalled()
  expect(reopen).not.toHaveBeenCalled()
})

it('the deleted original Session reads its saved input only when disclosed and checks the frozen Host', async () => {
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockResolvedValue({ entries: [saved(), saved(archiveEntry('wrong-host-row', 'Foreign archived message', 'another-host'))], nextCursor: null })
  const runtimeId = 'foreign-same-host-alias'
  const foreign = { ...archiveEntry('source-row', 'Original Source with the same Host alias'), originalMember: sourceTarget(runtimeId) }
  useAppStore.setState({ agentSteerQueues: { [originalSourceInputOwnerKey(runtimeId, agent.id)]: [foreign] } })
  await dom.render(<SessionRecordDetails target={agent.control} deleted />)
  await dom.click('.session-record-details-trigger')
  expect(read).not.toHaveBeenCalled()
  const summary = [...document.querySelectorAll('summary')].find(item => item.textContent === 'Saved local inputs')!
  expect(summary).toBeDefined()
  await disclose(summary.parentElement as HTMLDetailsElement)
  expect(read).toHaveBeenCalledExactlyOnceWith({ ownerKey: agent.id, limit: 30 })
  expect(localRecords().map(record => record.querySelector('summary span')?.textContent)).toEqual([originalText])
})

it('compiled CLI and public RPC retain confirmed cold archives and exact operation semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'am-archive-'))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), execute: request => useAppStore.getState().executeControl(request) })
  const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockImplementation(async query => {
    if (query.operationId !== undefined) return { entries: [saved()], nextCursor: null }
    if (query.after === 'archive-next') return { entries: [saved(archiveEntry('second-cold', 'Another retained original input'))], nextCursor: null }
    return { entries: [saved(), saved(archiveEntry('foreign-archive', 'Wrong Host', 'wrong-host'))], nextCursor: 'archive-next' }
  })
  const submit = vi.spyOn(api.sessions, 'submitPrompt'), stop = vi.spyOn(api.sessions, 'stopInputWaiting')
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'message', 'pending', 'ls', '--session', agent.id], objectCliEnvironment(root))
    expect(result.stderr).toBe(''); expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).result.messages).toMatchObject([
      { pendingId: operationId, delivery: 'confirmed', archived: true, editable: false, text: originalText },
      { pendingId: 'second-cold', delivery: 'confirmed', archived: true }
    ])
    expect(read.mock.calls.map(([params]) => params)).toEqual([{ ownerKey: agent.id, limit: 100 }, { ownerKey: agent.id, limit: 100, after: 'archive-next' }])
    const target = { agentSessionId: agent.id, pendingId: operationId, expectedText: originalText }
    await expect(client.call('message.pending.archive', target)).resolves.toMatchObject({ changed: false, message: { pendingId: operationId, delivery: 'confirmed', text: originalText } })
    await expect(client.call('message.pending.restore', target)).rejects.toThrow('Core confirmed this original input')
    expect(read).toHaveBeenLastCalledWith({ ownerKey: agent.id, operationId, limit: 2 })
    expect(submit).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  } finally {
    await client.dispose()
    await server.stop()
    await rm(root, { recursive: true })
  }
})
