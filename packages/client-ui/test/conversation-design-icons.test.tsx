// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { projectConversationWindow } from '../src/lib/conversation-records'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { WorkflowStatusGlyph as SharedStatusGlyph } from '../src/components/WorkflowObservation'
import { AgentProviderIcon } from '../src/components/AgentProviderIcon'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { SemanticIcon, createSemanticIconElement, getSemanticIconCatalog, semanticIconHref, updateIconSprite, removeIconSprite } from '../src/theme/icons'
import { GRAPHITE_THEME } from '../src/theme/catalog'
import { parseThemeFile, serializeThemeFile } from '../src/theme/schema'
import { WorkflowCard } from '../../../apps/desktop/src/renderer/src/components/workflow/WorkflowCard'
import { WorkflowToolRow } from '../../../apps/desktop/src/renderer/src/components/workflow/WorkflowToolRow'
import { WorkflowStatusGlyph } from '../../../apps/desktop/src/renderer/src/components/workflow/WorkflowStatusGlyph'
import { runningWorkflow } from '../../../apps/desktop/src/renderer/src/components/workflow/fixtures'
import { WorkflowSemanticIcon } from '../../../apps/desktop/src/renderer/src/components/semantic-icons'

const closes: Array<() => Promise<unknown>> = []
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  updateIconSprite(document, GRAPHITE_THEME, '#a0a0a0')
})
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); removeIconSprite(document); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function surface() {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}

it.each([false, true])('typed native and captured process headers retain their original icon meaning, deferred %s', async deferred => {
  const native = (uuid: string, role: 'assistant' | 'user', content: unknown[]) => ({ uuid, type: role, sessionId: 'native-icons', message: { role, content } })
  const f = await nativeHistoryFixture('claude', jsonl([
    native('call', 'assistant', [{ type: 'tool_use', id: 'exact-call', name: 'result and error are only a name', input: { exact: true } }]),
    native('result', 'user', [{ type: 'tool_result', tool_use_id: 'exact-call', content: 'Error is ordinary output text.', is_error: false }]),
    native('orphan-result', 'user', [{ type: 'tool_result', tool_use_id: 'original-unpaired-call', content: 'Original independent result.', is_error: false }]),
    native('reasoning', 'assistant', [{ type: 'thinking', thinking: 'Tool call words are only reasoning content.' }])
  ]), { nativeSessionId: 'native-icons' })
  closes.push(f.close)
  const original = await f.client.sessionHistoryPage(f.session.agentSessionId)
  // The existing Provider output port supplies two typed originals not present in
  // this Claude transcript. Their body/title never determines their icon meaning.
  const page: AgentSessionHistoryPage = { ...original, items: [...original.items,
    { id: 'collaboration', kind: 'activity', title: 'Read', contentParts: [{ kind: 'text', text: 'Bash result' }], collaboration: { kind: 'operation', operation: 'wait', status: 'running', receivers: [], agentStates: [] } },
    { id: 'ordinary', kind: 'activity', title: 'tool-result', contentParts: [{ kind: 'text', text: 'spawn_agent' }] }
  ] }
  const { readConversationChanges: _incremental, ...provider } = f.client.providers.get('claude')
  f.client.providers.replace({ ...provider, readSessionHistoryPage: async () => page })
  for (const [id, kind] of [['captured-call', 'tool_call'], ['captured-permission', 'permission']] as const)
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id, agentSessionId: f.session.agentSessionId,
      kind, source: 'agentmux', title: 'Tool result and error', status: 'complete', content: 'Original captured body', createdAt: 1, updatedAt: 1 } })
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
  let snapshot: ConversationWindowSnapshot
  for (;;) {
    const value = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 100, ...(deferred ? { processDetails: 'deferred' } : {}), ...(cursor ? { cursor } : {}) })
    const accepted = consumeConversationWindowPage(value, pending)
    if (accepted.kind === 'complete') { snapshot = accepted.snapshot; break }
    pending = accepted.pending; cursor = value.nextCursor!
  }
  const projection = projectConversationWindow(snapshot), { host, render } = surface()
  if (process.env.AGENTMUX_DESIGN_ICON_FRAMES) {
    await mkdir(process.env.AGENTMUX_DESIGN_ICON_FRAMES, { recursive: true })
    await writeFile(join(process.env.AGENTMUX_DESIGN_ICON_FRAMES, `${deferred ? 'deferred' : 'eager'}.json`), JSON.stringify({ snapshot,
      qualification: 'Real Claude transcript call/result/reasoning plus typed collaboration/ordinary Provider contribution, captured FileStore originals, public Core read and projection; controlled renderer fixture, no vendor/model/Runtime control.' }, null, 2))
  }
  await render(<ConversationView sessionId={f.session.agentSessionId} executionHostId="local" page={projection.historyPage} timeline={projection.captured}
    records={projection.records} originalRecords={projection.originalRecords} renderProcess={props => <NativeProcessObservation {...props} />} />)
  const expected = { call: 'conversation.tool-call', result: 'conversation.tool-result', 'orphan-result': 'conversation.tool-result', reasoning: 'object.activity', collaboration: 'object.collaboration', ordinary: 'object.activity', 'captured-call': 'conversation.tool-call', 'captured-permission': 'status.permission' }
  for (const [id, icon] of Object.entries(expected)) {
    const row = host.querySelector(`[data-observation-step-id="${id}"]`)
    expect(row, `Actual original row ${id}`).not.toBeNull()
    expect(row!.querySelector('[data-semantic-icon]')?.getAttribute('data-semantic-icon'), `typed-icon:${id}`).toBe(icon)
  }
  expect(host.querySelector('[data-observation-step-id="result"]')?.getAttribute('data-status')).not.toBe('failed')
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
  expect(host.querySelector('pre')).toBeNull()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('real Workflow object slots and the ordinary Provider fallback consume the same discovered authored defaults', async () => {
  const { host, render } = surface()
  await render(<><WorkflowCard workflow={runningWorkflow} /><WorkflowToolRow title="Recorded tool" workflowName="Original Workflow" status="completed" duration="recorded" /><AgentProviderIcon providerId="private-unknown-provider" /></>)
  expect(host.querySelector('.wf-card > .wf-head [data-semantic-icon="object.workflow"]')).not.toBeNull()
  expect(host.querySelector('.wf-tool-row__workflow [data-semantic-icon="object.workflow"]')).not.toBeNull()
  expect(host.querySelector('[data-semantic-icon="object.branch"]')).toBeNull()
  const fallback = host.querySelector('[data-agent-provider="private-unknown-provider"]')!
  expect(fallback.querySelector('[data-semantic-icon="object.agent"]')).not.toBeNull()
  const catalog = getSemanticIconCatalog()
  expect(catalog.icons.find(icon => icon.id === 'object.workflow')?.defaultGlyph).toBe('workflow-route')
  expect(catalog.icons.find(icon => icon.id === 'object.agent')?.defaultGlyph).toBe('agent-unit')
  expect(catalog.glyphs).toContain('workflow-route'); expect(catalog.glyphs).toContain('agent-unit')
  const saved = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.design-icons', name: 'Original saved choices', icons: {
    'object.workflow': { kind: 'paths', paths: [{ d: 'M3 4h18v16H3Z' }] }, 'object.agent': { kind: 'glyph', glyph: 'bot' }
  } }))
  const before = serializeThemeFile(saved), workflowId = semanticIconHref('object.workflow').slice(1)
  updateIconSprite(document, saved, '#ffffff')
  expect(document.getElementById(workflowId)?.querySelector('path')?.getAttribute('d')).toBe('M3 4h18v16H3Z')
  expect(document.getElementById(workflowId)?.querySelector('[data-semantic-icon-part]')).toBeNull()
  const native = createSemanticIconElement('object.agent', document, { size: 12 })
  expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.agent'))
  expect(serializeThemeFile(saved)).toBe(before)
})

it('current Workflow activity uses the original local orbit while recorded, queued and terminal states stay static', async () => {
  const { host, render } = surface()
  await render(<><span data-current><WorkflowStatusGlyph status="running" /></span><span data-adapter><WorkflowSemanticIcon status="running" /></span><span data-recorded><WorkflowStatusGlyph status="running" recorded /><SharedStatusGlyph status="running" recorded /></span>
    <span data-static><WorkflowStatusGlyph status="queued" /><WorkflowStatusGlyph status="completed" /><WorkflowStatusGlyph status="failed" /><SemanticIcon name="status.unknown" /></span></>)
  expect(host.querySelector('[data-current] [data-icon-animation="orbit"] [data-semantic-icon="status.workflow-running"]')).not.toBeNull()
  expect(host.querySelector('[data-adapter] [data-icon-animation="orbit"] [data-semantic-icon="status.workflow-running"]')).not.toBeNull()
  expect(host.querySelector('[data-recorded] [data-icon-animation]')).toBeNull()
  expect(host.querySelector('[data-static] [data-icon-animation]')).toBeNull()
  const symbol = document.getElementById(semanticIconHref('status.workflow-running').slice(1))!
  expect(symbol.querySelectorAll('[data-semantic-icon-part="progress-arc"]')).toHaveLength(1)
  expect(symbol.querySelectorAll('circle:not([data-semantic-icon-part])')).toHaveLength(1)
  expect(host.querySelector('[data-icon-animation="spin"]')).toBeNull()
})
