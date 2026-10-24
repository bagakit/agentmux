// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ChannelHeaderControl } from '../src/renderer/src/components/settings/ChannelHeaderControl'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original linked group', chat_status: 'normal', chat_mode: 'group' } }
} })
const entry = (adapter: string) => document.querySelector(`[data-workbench-region-id="original-region"] [data-channel-entry="${adapter}"]`)
const writes = () => f.calls.filter(call => /configure|\.bind$|\.grant$|\.create$|\.retry$/.test(call.method))
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 }) }

it('hides an actually bound platform through ConfigOwner while retaining its original group and Host traffic policy', async () => {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_original_display_group')
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(f.services.bindings!.listActive()).toHaveLength(1)); await f.button('Close')
  await wait(() => expect(entry('feishu')).not.toBeNull())
  const original = structuredClone(f.services.bindings!.listActive()), before = writes().length
  const policy = await f.services.connections.service!.get({ adapterId: 'feishu' })
  const config = await configOwnerFixture(useAppStore.getState().config!)
  const publish = config.publish.getMockImplementation()!
  config.publish.mockImplementation(saved => { publish(saved); useAppStore.getState().setConfig(saved) })
  useAppStore.getState().setConfig(config.owner.current)
  vi.spyOn(api.config, 'save').mockImplementation((next, expected) => config.owner.edit(expected!, next))
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  try {
    await act(async () => root.render(<ChannelHeaderControl platform={{ adapterId: 'feishu', title: 'Lark' }} />))
    await act(async () => node.querySelector<HTMLInputElement>('input')!.click())
    expect(entry('feishu'), 'uncommitted display choice keeps the original entry').not.toBeNull()
    // An unrelated concurrent preference remains owned by ConfigOwner and is not overwritten.
    await act(async () => { const current = config.owner.current; await config.owner.edit(current, { ...current, appearance: { ...current.appearance, editorFontSize: 17 } }) })
    await act(async () => node.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click())
    await wait(() => expect(entry('feishu'), 'saved display preference hides the original bound platform').toBeNull())
    expect(entry('discord')).not.toBeNull(); expect(entry('other')).toBeNull()
    expect(f.services.bindings!.listActive()).toEqual(original)
    expect(await f.services.connections.service!.get({ adapterId: 'feishu' })).toEqual(policy)
    expect(writes()).toHaveLength(before)
    const disk = await config.disk()
    expect(disk.appearance.channelHeaderVisibility).toEqual({ feishu: false })
    expect(disk.appearance.editorFontSize).toBe(17)
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
    await act(async () => node.querySelector<HTMLInputElement>('input')!.click())
    await act(async () => node.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click())
    await wait(() => expect(entry('feishu')).not.toBeNull())
    expect(writes()).toHaveLength(before)
    if (process.env.PLATFORM_CONTROL_FACTS) await writeFile(process.env.PLATFORM_CONTROL_FACTS + '.binding.json', JSON.stringify({ passed: true, binding: original[0]?.bindingId, bindingsUnchanged: true, policyUnchanged: true, serviceWrites: writes().length - before, noOtherEntry: true, restored: true, preservedConcurrentFont: disk.appearance.editorFontSize }, null, 2) + '\n')
  } finally { await act(async () => root.unmount()); node.remove() }
}, 20_000)
