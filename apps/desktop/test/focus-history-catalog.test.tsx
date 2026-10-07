// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useFocusHistorySources, type FocusHistoryCatalogue } from '../src/renderer/src/lib/focus-history-sources'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const dom = composerDOM()
const sources = (count: number): AgentSessionHistoryDescriptor[] => Array.from({ length: count }, (_, index) => ({
  hostId: 'original-host', agentSessionId: `retained-original-${index}`, state: 'retired'
}))
let observed: FocusHistoryCatalogue
function Catalogue({ enabled = true }: { enabled?: boolean }) {
  observed = useFocusHistorySources(enabled)
  return <output data-count={observed.sources.length} data-available={observed.available}>{observed.error}</output>
}
beforeEach(() => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  useAppStore.setState({ config: composerConfig, sessions: [], timelines: {}, tabs: {}, layouts: {},
    mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    scratchTopicSnapshots: {}, spatialRequests: {}, spaceZoneBindings: {}, topicCategories: [] })
})

it.each([513, 1025])('retains every valid source from an original catalogue of %i', async count => {
  const original = sources(count), read = vi.spyOn(api.sessions, 'historySources').mockResolvedValue(original)
  await dom.render(<Catalogue />)
  expect(observed.error).toBeNull()
  expect(observed.available).toBe(true)
  expect(observed.sources).toBe(original)
  expect(observed.sources.at(-1)?.agentSessionId).toBe(`retained-original-${count - 1}`)
  expect(read).toHaveBeenCalledOnce()
})

it('keeps the complete known catalogue after a failed refresh and retries the original owner', async () => {
  const original = sources(513), refreshed = sources(1025)
  const read = vi.spyOn(api.sessions, 'historySources').mockResolvedValueOnce(original)
    .mockRejectedValueOnce(new Error('Original source observation unavailable')).mockResolvedValueOnce(refreshed)
  await dom.render(<Catalogue />)
  await act(async () => observed.refresh())
  expect(observed.sources).toBe(original)
  expect(observed.error).toContain('Original source observation unavailable')
  expect(observed.available).toBe(false)
  await act(async () => observed.refresh())
  expect(observed.sources).toBe(refreshed)
  expect(observed.error).toBeNull()
  expect(observed.available).toBe(true)
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not start catalogue observation for an inactive consumer or apply its late result', async () => {
  let resolve!: (value: AgentSessionHistoryDescriptor[]) => void
  const read = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => new Promise(done => { resolve = done }))
  await dom.render(<Catalogue enabled={false} />)
  expect(read).not.toHaveBeenCalled()
  await dom.render(<Catalogue />)
  expect(read).toHaveBeenCalledOnce()
  await dom.render(<Catalogue enabled={false} />)
  await act(async () => resolve(sources(513)))
  expect(observed.sources).toHaveLength(0)
  expect(observed.error).toBeNull()
})

it('finds a retained conversation beyond the old threshold in the real Focus consumer without reading bodies or controlling Runs', async () => {
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue(sources(513))
  const history = vi.spyOn(api.sessions, 'historyPage'), search = vi.spyOn(api.search, 'query')
  const controls = (['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const)
    .map(name => vi.spyOn(api.sessions, name))
  await dom.render(<GlobalFocusSurface workspaceOpen={false} />)
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'retained-original-512')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const result = dom.container.querySelector('[aria-label="Matching retained conversations"]')
  expect(result).not.toBeNull()
  expect(result!.querySelectorAll('strong')).toHaveLength(1)
  expect(result!.querySelector('strong')?.textContent).toBe('retained-original-512')
  expect(result!.querySelector('button')?.textContent).toBe('Read conversation')
  expect(dom.container.textContent).not.toContain('Core catalogue limit')
  expect(history).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled()
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})
