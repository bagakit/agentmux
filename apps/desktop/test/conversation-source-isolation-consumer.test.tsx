import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('actual Activity keeps independent captured speech visible with a persistent Retry when the exact native changes cut is rejected', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'retained-native', sessionId: 'native-main', message: { role: 'user', content: 'Original retained native speech' } }]))
  closes.push(f.close); await desktopConversationReadBridge(f, closes)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); check() }, { timeout: 7000 })
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })} />))
  await wait(() => { expect(host.textContent).toContain('Original retained native speech'); expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(0) })
  await writeFile(f.path, jsonl([{ type: 'user', uuid: 'replacement', sessionId: 'native-main', message: { role: 'user', content: 'Unaccepted replacement bytes' } }]))
  await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id: 'captured-progress', agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Independent captured speech', content: 'Readable independent captured speech', createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1) } })
  await wait(() => { expect(host.textContent).toContain('Readable independent captured speech'); expect(host.textContent).toContain('Original retained native speech') })
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Retry'))
  expect(retry, 'Accurate source failure remains actionable in the actual toolbar').toBeDefined(); expect(retry!.disabled).toBe(false)
  expect(host.textContent).not.toContain('Unaccepted replacement bytes')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
