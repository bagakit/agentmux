// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const closes: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllGlobals() })

it('keeps the working indicator inside the readable extent that following pins to', async () => {
  const session = composerSession(); useAppStore.setState({ sessions: [session] })
  const source = { providerId: 'codex', nativeSessionId: 'native-working' }
  const f = await conversationPagePortFixture(session.control, source, async () => ({ agentSessionId: session.id, source, nextCursor: null,
    items: [{ id: 'asked', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Run the tests' }] }] }))
  closes.push(f.close)
  await dom.render(<ActivityView {...activityReadingProps({ control: session.control })} displayState="working" />)
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const consumer = inspectConversationConsumers(session.control).consumers[0]
    expect(consumer?.accepted).not.toBeNull(); expect(consumer?.loading).toBe(false)
    expect(dom.container.querySelector('[data-native-record-id="asked"]')).not.toBeNull()
  })
  const working = dom.container.querySelector<HTMLElement>('.activity-working')
  const tail = dom.container.querySelector<HTMLElement>('[data-conversation-reading-tail]')
  expect(working).not.toBeNull(); expect(tail).not.toBeNull()
  // Following scrolls the tail marker to the bottom edge; whatever precedes it is visible there.
  expect(working!.compareDocumentPosition(tail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
