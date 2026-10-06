// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { sessionSnapshotPayload } from '../src/main/session-snapshot-payload'
import { WorkspaceRowContextMenu } from '../src/renderer/src/components/WorkspaceRowContextMenu'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { historySourcesReader, providerCatalogReader } from './helpers/startup-observation-api-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

const dom = composerDOM()
const home = fixturePath('copy-home')
const path = fixturePath('copy-home/projects/example')
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined })

describe('Main snapshot to project menu clipboard', () => {
  it.each([
    { host: 'local', absolute: undefined, home, expected: '~/projects/example' },
    { host: 'local', absolute: false, home, expected: '~/projects/example' },
    { host: 'local', absolute: true, home, expected: path },
    { host: 'remote', absolute: false, home, expected: path },
    { host: 'local', absolute: false, home: undefined, expected: path }
  ])('copies the confirmed path style: %j', async ({ host, absolute, home: snapshotHome, expected }) => {
    const config = { ...composerConfig,
      hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'example.invalid' }],
      workspaces: [{ id: 'project', name: 'Project', hostId: host, kind: 'folder' as const, path }],
      ...(absolute === undefined ? {} : { copyPathsAsAbsolute: absolute }) }
    useAppStore.setState({ config, localHome: '', sessions: [], tabs: {}, layouts: {}, restoredWorkbench: null })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
    vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader([]))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(sessionSnapshotPayload(
      { sessions: [], timelines: {}, recoveryCandidates: [] }, undefined, snapshotHome))
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)

    await act(async () => { dispose = await useAppStore.getState().initialize() })
    await dom.render(<WorkspaceRowContextMenu path={path} branch={null} isLocal={host === 'local'} workspaceId="project">
      <button type="button" data-project-row>Project</button>
    </WorkspaceRowContextMenu>)
    const row = dom.container.querySelector<HTMLElement>('[data-project-row]')!
    expect(row).not.toBeNull()
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 60 })))
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Copy Path')
    expect(item).toBeDefined()
    await act(async () => item!.click())

    expect(copy).toHaveBeenCalledExactlyOnceWith(expected)
    expect(useAppStore.getState().localHome).toBe(snapshotHome ?? '')
    expect(useAppStore.getState().config!.workspaces[0]!.path).toBe(path)
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).not.toHaveProperty('localHome')
  })
})
