// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StaticActivityView as ActivityView } from './helpers/conversation-static-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import * as previews from '@agentmux/client-ui/conversation-reply-preview'

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('the actual Activity captured adapter stops preview work while its original reading face is hidden', async () => {
  const preview = vi.spyOn(previews, 'conversationReplyPreview'), sid = 'activity-reader'
  const render = async (enabled: boolean, content: string) => {
    const items = [{ id: 'original-hook', agentSessionId: sid, kind: 'assistant_message' as const, source: 'native-hook' as const,
      eventName: 'Stop', title: 'Reply snapshot', status: 'complete' as const, content, createdAt: 1, updatedAt: 1 }]
    await act(async () => root.render(<ActivityView sessionId={sid} executionHostId="local" capability="complete-events" items={items}
      timelineSnapshot={{ agentSessionId: sid, sourceHostId: 'local', revision: 1, items }} nativeHistoryPage={null}
      conversationReading={{ reference: { hostId: 'local', agentSessionId: sid }, identity: 'original-reader', enabled }} />))
  }
  await render(true, '**Original** snapshot')
  expect(host.querySelector('[data-captured-reply-observation]')).not.toBeNull()
  expect(preview).toHaveBeenCalledTimes(1)
  await render(false, '**Later** original snapshot')
  expect(preview).toHaveBeenCalledTimes(1)
  await render(true, '**Later** original snapshot')
  expect(preview).toHaveBeenCalledTimes(2)
  expect(host.querySelector('.conversation-reply-observation__preview')?.textContent).toBe('Later original snapshot')
})
