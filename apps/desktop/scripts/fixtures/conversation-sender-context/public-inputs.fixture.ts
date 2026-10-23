import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { fixtureIso as _hygiene_fixtureIso } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentSessionHistoryPageOptions, type AgentSessionHistorySource, type AgentTimelineSnapshot } from '@agentmux/core'
import { vi } from 'vitest'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
import type { AppConfig, AgentSessionControl, SessionSnapshot } from '../../../src/shared/contracts'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'

export const RECIPIENT_ID = 'sender-context-recipient'
export const DECLARED_ID = 'sender-context-declared'
export const TRUSTED_ID = 'sender-context-trusted'
export const NATIVE_SESSION_ID = 'sender-context-native'
export const RAW_IDS = ['original-native-first', 'original-native-second'] as const
export function messageWire(senderSessionId: string, body: string) {
  return renderAgentMuxMessageEnvelope({ messageId: 'original-sender-message',
    sender: { kind: 'agent-session', agentSessionId: senderSessionId }, senderSessionId, body })
}
export const NATIVE_WIRE = messageWire(DECLARED_ID, '**One original passage**\nSame body, separate original records.')
export const TRUSTED_WIRE = messageWire('conflicting-declaration', 'The recorded author remains authoritative.')

export function agent(id: string, workspacePath: string, label = id): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', workspacePath, label, providerId: 'claude', executorId: 'claude',
    agentSessionUpdatedAt: 3000, promptSubmissionPredecessor: null, createdAt: 1000, updatedAt: 9000,
    processState: 'running', status: { state: 'done', source: 'run-process', observedAt: 9000 },
    latestOutputBytes: 0, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `private-no-process-${id}` } } }
}

export function metadata(workspacePath: string) {
  const senderPath = join(workspacePath, 'sender-project'), otherPath = join(workspacePath, 'unrelated-project')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private source fixture' }],
    executors: { claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [
      { id: 'recipient-project', hostId: 'local', path: workspacePath, kind: 'folder', name: 'Recipient project' },
      { id: 'sender-project', hostId: 'local', path: senderPath, kind: 'folder', name: 'Current sender project' },
      { id: 'other-project', hostId: 'local', path: otherPath, kind: 'folder', name: 'Unrelated project' }
    ], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const sessions = [agent(RECIPIENT_ID, workspacePath, 'Recipient agent'), agent(DECLARED_ID, senderPath, 'Current declared sender'), agent(TRUSTED_ID, senderPath, 'Current trusted sender'), agent('unrelated-agent', otherPath, 'Unrelated agent')]
  const goal = (id: string, title: string, sessionIds: string[]): DemandRecord => ({ id, title, description: 'Explicit persisted goal association', status: 'in_progress', priority: 'normal', projectId: 'sender-project', projectName: 'Current sender project', sessionIds, createdAt: 10, updatedAt: 20, source: 'session' })
  const demands = { explicit: goal('explicit', 'Explicit sender goal', [DECLARED_ID, TRUSTED_ID]), unrelated: goal('unrelated', 'Unrelated goal with matching words', ['unrelated-agent']) }
  const timeline: AgentTimelineSnapshot = { agentSessionId: RECIPIENT_ID, revision: 1, items: [
    { id: 'captured-trusted', agentSessionId: RECIPIENT_ID, kind: 'user_message', source: 'user', status: 'complete', createdAt: 3500, updatedAt: 3500, title: 'Captured input', content: TRUSTED_WIRE, authorAgentSessionId: TRUSTED_ID },
    { id: 'captured-unmatched', agentSessionId: RECIPIENT_ID, kind: 'user_message', source: 'user', status: 'complete', createdAt: 4000, updatedAt: 4000, title: 'Captured input', content: messageWire('missing-sender', 'Unmatched declaration remains a declaration.') }
  ] }
  return { config, sessions, demands, timeline }
}

/** Controlled on-disk Claude records through the real reader and public Core API; no vendor writer, Runtime or process. */
export async function publicNativeInputs(observeClient?: (client: AgentMuxClient) => void, wire = NATIVE_WIRE, includeTrace = false) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'conversation-sender-context-'))
  const transcriptPath = join(workspacePath, 'native.jsonl'), storePath = join(workspacePath, 'sessions.json')
  await writeFile(transcriptPath, RAW_IDS.map((uuid, index) => JSON.stringify({ sessionId: NATIVE_SESSION_ID, uuid, type: 'user',
    ...(index === 0 ? { timestamp: _hygiene_fixtureIso(-_privacyFixtureEpoch(20453, 86397)) } : {}), message: { role: 'user', content: [{ type: 'text', text: wire },
      ...(includeTrace ? [{ type: 'tool_result', tool_use_id: 'original-tool-call', content: 'Original native tool result survives details.' }] : [])] } })).join('\n') + '\n')
  const source = metadata(workspacePath), recipient = source.sessions.find(session => session.id === RECIPIENT_ID)!
  const control: AgentSessionControl = recipient.control
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: RECIPIENT_ID, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath,
    run: control.run, retiredRuns: [], createdAt: 1000, updatedAt: 1000, hookBindingId: 'private-sender-context', hookToken: 'private-fixture-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: NATIVE_SESSION_ID, transcriptPath } })
  const client = new AgentMuxClient({ store })
  observeClient?.(client)
  for (const item of source.timeline.items) await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: RECIPIENT_ID, item },
    { source: 'agentmux', observedAt: item.updatedAt }, 'local')
  const timeline = await client.sessionTimeline(RECIPIENT_ID)
  const storeBefore = await readFile(storePath), transcriptBefore = await readFile(transcriptPath)
  async function page(): Promise<AgentSessionHistoryPage> { return client.sessionHistoryPage(RECIPIENT_ID) }
  async function unchanged() { return { store: (await readFile(storePath)).equals(storeBefore), transcript: (await readFile(transcriptPath)).equals(transcriptBefore) } }
  const firstPage = await page(), messages = projectSessionUserMessages({ agentSessionId: RECIPIENT_ID, historyPage: firstPage, timeline })
  // Count the exact original Provider read, including the source-qualified
  // ConversationWindow path, after the fixture's initial input preparation.
  const originalRead: (agentSessionId: string, options: AgentSessionHistoryPageOptions,
    source?: AgentSessionHistorySource) => Promise<AgentSessionHistoryPage> = client['readSessionHistoryPage']
  const nativeHistory = vi.fn(async function (this: AgentMuxClient, ...args: Parameters<typeof originalRead>) {
    assert.equal(this, client)
    assert.equal(args[0], RECIPIENT_ID)
    if (args[2]) assert.deepEqual(args[2], { providerId: 'claude', nativeSessionId: NATIVE_SESSION_ID })
    return originalRead.apply(this, args)
  })
  client['readSessionHistoryPage'] = nativeHistory
  async function dispose() { client['readSessionHistoryPage'] = originalRead; await client.dispose(); await rm(workspacePath, { recursive: true }) }
  return { ...source, timeline, workspacePath, control, client, page, firstPage, messages, unchanged, dispose, nativeHistory }
}
