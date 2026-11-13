// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import { composerDOM } from './helpers/composer-dom-fixture'

// A navigation request names one section. Only that section's editor receives it; every other
// visited editor keeps its own state, and channel editors stay mounted while another section is shown.
const dom = composerDOM()
const origin = { hostingTarget: { hostId: 'studio', runtimeId: 'runtime-studio' }, target: null, topicId: 'topic-1', moteName: 'Atlas' } as never
const hostingCalls: unknown[] = []
beforeEach(async () => {
  hostingCalls.length = 0
  useAppStore.setState({ config: await api.config.get() })
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation(async (hostId?: string) => {
    hostingCalls.push(hostId)
    return { hostId: hostId ?? 'local', runtimeId: `runtime-${hostId ?? 'local'}` } as never
  })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method: string) => {
    if (method === 'connection.ls') return { connections: [] } as never
    throw new Error(`unexpected ${method}`)
  })
})
const pane = (id: string) => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${id}"]`)
const hostChoice = (id: string) => pane(id)?.querySelector<HTMLSelectElement>('[aria-label="Connector hosting Host"]')
const choose = async (id: string) => { await act(async () => dom.container.querySelector<HTMLElement>(`.settings-sidebar [data-settings-target="${id}"]`)!.click()) }
async function settle() { for (let n = 0; n < 20; n++) await act(async () => { await new Promise(done => setTimeout(done, 5)) }) }

it('delivers a Mote Lark request to Lark only, so Discord keeps its own Host', async () => {
  const request: SettingsNavigationRequest = { section: 'lark', moteLarkOrigin: origin }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="lark" navigationRequest={request} />)
  await settle()
  expect(hostChoice('lark')!.selectedOptions[0]!.textContent).not.toBe('Background Host on this device')
  await choose('discord')
  await settle()
  // Discord reads its own Host; the Lark origin's Host never appears there.
  expect(hostChoice('discord')!.selectedOptions[0]!.textContent).toBe('Background Host on this device')
  expect(hostingCalls).toContain('local')
})

it('keeps a visited channel editor mounted with its draft while another section is shown', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="lark" />)
  await settle()
  const lark = pane('lark')!
  const before = lark.querySelector('[data-connection-hosting]')
  expect(before).not.toBeNull()
  await choose('discord')
  await settle()
  // The hidden Lark editor is the same DOM instance, not an emptied or remounted one.
  expect(lark.hidden).toBe(true)
  expect(lark.querySelector('[data-connection-hosting]')).toBe(before)
  await choose('lark')
  expect(pane('lark')!.querySelector('[data-connection-hosting]')).toBe(before)
})

it('states a requested field that the section does not show, outside search too', async () => {
  const request: SettingsNavigationRequest = { section: 'general', field: 'not-a-general-field' }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" navigationRequest={request} />)
  await settle()
  expect(pane('general')!.querySelector('[data-settings-target-issue]')?.textContent).toContain('not shown in the current view')
})

it('lands the Host executors request on its real anchor without an issue', async () => {
  const request: SettingsNavigationRequest = { section: 'agents', field: 'host-executors', hostId: 'local' }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="agents" navigationRequest={request} />)
  await settle()
  const target = pane('agents')!.querySelector<HTMLElement>('[data-settings-field="host-executors"]')
  expect(target).not.toBeNull()
  expect(target!.hidden).toBe(false)
  expect(pane('agents')!.querySelector('[data-settings-target-issue]')).toBeNull()
})

it('says on Overview that no section manages an unrecognized channel application', async () => {
  const channelOrigin = { sessionId: 's', hostId: 'local', agentSessionId: 'a', connection: { connectionId: 'c', adapterId: 'matrix', application: { domain: 'matrix.example', appId: 'app' } } }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="overview" navigationRequest={{ section: 'overview', channelOrigin }} />)
  await settle()
  expect(dom.container.querySelector('[data-settings-overview] [data-settings-target-issue]')?.textContent).toContain('matrix.example')
})
