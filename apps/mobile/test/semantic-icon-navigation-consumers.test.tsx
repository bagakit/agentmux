import { renderToStaticMarkup } from 'react-dom/server'
import { SpaceAppearanceIcon } from '@agentmux/client-ui/components/SpaceAppearanceIcon'
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { MobilePrimaryNavigation } from '../src/navigation/MobilePrimaryNavigation'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { createBrowserPlatform } from '../src/platform/browser'
import { fixturePath } from '../../../test/fixture-values.mjs'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

let root: Root, host: HTMLDivElement, release: () => void
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); release = mountThemeRuntime(window) })
afterEach(async () => { await act(async () => root.unmount()); release(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => { root.render(node) }) }
function drawing(node: ParentNode, id: string) { expect(node.querySelector(`[data-semantic-icon="${id}"]`), `actual mobile ${id}`).not.toBeNull() }

it('the real Topics and Focus navigation use separate semantic drawings and preserve exact workface selection', async () => {
  const select = vi.fn()
  await render(<MobilePrimaryNavigation current="topics" onSelect={select} />)
  const topics = host.querySelector('[data-workface="topics"]')!, focus = host.querySelector('[data-workface="focus"]')!, space = host.querySelector('[data-workface="space"]')!
  drawing(topics, 'object.topic'); drawing(focus, 'navigation.focus'); drawing(space, 'navigation.space')
  const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.mobile-topics'; theme.name = 'Original Topics'; theme.icons = { 'object.topic': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } }
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  expect(document.getElementById(semanticIconHref('object.topic').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(host.querySelector('[data-workface="topics"]')).toBe(topics)
  await act(async () => { (focus as HTMLButtonElement).click() })
  expect(select).toHaveBeenCalledExactlyOnceWith('focus')
  expect(topics.getAttribute('aria-current')).toBe('page')
})

it('the original platform keeps Project, System and neutral presentation independent without inventing a queue', async () => {
  const platform = createBrowserPlatform(), project = { workspaceId: 'original-project', name: 'Original project', path: fixturePath('mobile-original-project') }
  await render(<><div data-project>{platform.renderProjectIcon(project)}</div><div data-system>{platform.renderMessageAvatar({ speaker: { role: 'system', id: 'original-system' }, name: 'Original system' })}</div><div data-neutral>{platform.renderIcon('neutral', 12)}</div></>)
  drawing(host.querySelector('[data-project]')!, 'object.project'); drawing(host.querySelector('[data-system]')!, 'object.system'); drawing(host.querySelector('[data-neutral]')!, 'status.neutral')
  expect(host.querySelector('[data-semantic-icon="status.queued"]')).toBeNull()
  expect(host.querySelector('[data-speaker-id]')?.getAttribute('data-speaker-id')).toBe('original-system')
  expect(host.querySelector('[data-project] [aria-label]')?.getAttribute('aria-label')).toBe(project.name)
})

it('actual spatial resource rows draw the exact typed content kind while leaving unresolved Regions and original targets intact', async () => {
  const kinds = ['file', 'browser', 'launcher', 'terminal'] as const
  const catalog = { spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original Space', hostId: 'original-host', directoryPath: fixturePath('mobile-space'), projectId: null }], zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', hostId: 'original-host', directoryPath: fixturePath('mobile-space'), kind: 'home', branch: null }], tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original Tab', regionIds: kinds.map(kind => `original-${kind}`) }], regions: kinds.map(kind => ({ regionId: `original-${kind}`, tabId: 'original-tab', kind, ...(kind === 'file' ? { file: { path: 'original-file.txt', workspaceId: 'original-workspace' } } : {}), ...(kind === 'browser' ? { browserId: 'original-browser' } : {}) })), bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }], locations: [] }
  const rpc = vi.fn().mockResolvedValue({ catalog }), openSession = vi.fn()
  const client = { forwardRpc: rpc } as unknown as AgentMuxHostedClient
  await render(<MobileSpatialNavigation home="space" client={client} connected sessions={[]} initialContext={{ spaceId: 'original-space', tabId: null, regionId: null }} openSession={openSession} />)
  await vi.waitFor(() => expect(host.querySelectorAll('.mobile-spatial-tab li')).toHaveLength(4))
  const rows = [...host.querySelectorAll('.mobile-spatial-tab li')]
  for (const [index, id] of ['object.file', 'object.browser', 'object.launcher', 'object.region'].entries()) drawing(rows[index]!, id)
  expect(rows[0]?.textContent).toContain('original-file.txt')
  expect(host.querySelector('.mobile-spatial-tab')?.textContent).toContain('Original Tab')
  expect(host.textContent).toContain('此内容在 Mac 上查看')
  expect(openSession).not.toHaveBeenCalled()
  expect(rpc).toHaveBeenCalledExactlyOnceWith('space.ls', { target: {}, presentation: true })
})

it('shares the original App monogram grapheme in the actual project icon', () => { expect(renderToStaticMarkup(<SpaceAppearanceIcon name="👨‍👩‍👧 Project" preset="directory" />)).toContain("👨‍👩‍👧") })
