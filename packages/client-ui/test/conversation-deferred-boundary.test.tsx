// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { projectConversationWindow } from '../src/lib/conversation-records'
import { ConversationView } from '../src/components/ConversationView'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import type { ConversationPresentationController } from '../src/lib/use-conversation-record-layout'

it('precommit and committed layout retain the same selected boundary for an exact deferred native record', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(['first', 'boundary'].map(id => ({ type: 'assistant', uuid: id, sessionId: 'native-main',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `call-${id}`, name: 'inspect', input: { body: id } }] } }))))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, processDetails: 'deferred' }))
    if (read.kind !== 'complete') throw Error('Small real summary must finish')
    const frame = projectConversationWindow(read.snapshot)
    expect(frame.records).toHaveLength(2)
    expect(frame.records.every(record => record.original.kind === 'deferred')).toBe(true)
    const controller = { current: null as ConversationPresentationController | null }
    const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
    await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView sessionId={f.session.agentSessionId} executionHostId="local" records={frame.records}
      originalRecords={frame.originalRecords} page={frame.historyPage} presentation={{ controller, pending: false, onRelease: () => {} }}
      recordBoundary={{ beforeRecordId: 'boundary', content: <span data-test-history-boundary>Earlier original records</span> }} /></ClientUiProvider>))
    const boundary = host.querySelector('[data-test-history-boundary]')!
    expect(boundary).not.toBeNull()
    const range = document.createRange(); range.selectNodeContents(boundary); getSelection()!.addRange(range)
    expect(getSelection()!.toString()).toBe('Earlier original records')
    // Actual Activity's beforeCommit passes this original raw native ID. The same
    // candidate must keep its existing boundary even though its body is deferred.
    expect(controller.current!.canPresent(frame, { beforeRecordId: 'boundary' })).toBe(true)
    expect(controller.current!.canPresent(frame)).toBe(false)
    expect(getSelection()!.getRangeAt(0)).toBe(range)
    expect(host.querySelector('[data-test-history-boundary]')).toBe(boundary)
  } finally { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); await f.close() }
})
