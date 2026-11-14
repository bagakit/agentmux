import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Editor } from '@tiptap/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { FileReadOwner } from '../../host/src/file-read-owner'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { MobileZoneWorkface } from '../src/navigation/MobileZoneWorkface'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from '../src/navigation/MobileAgentRow'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, mount, mounted, waitForElement } from './conversation-fixture'

const cleanup: Array<() => unknown | Promise<unknown>> = []
beforeEach(() => localStorage.clear())
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const settled = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 10000 })
async function owner(name: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-zone-source-')))
  const files = new OrdinaryWorkspaceFiles()
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, 'zone'), { recursive: true })
  await writeFile(join(root, 'zone', 'original.note.md'), serializeNoteDocument(newNoteDocument(name + ' ORIGINAL FILE', 'same-note', 'same-block')))
  const catalog: AgentMuxSpaceCatalog = { spaces: [{ spaceId: 'same-space', kind: 'folder', hostId: 'local', name, directoryPath: root, projectId: null }],
    zones: [{ zoneId: 'same-zone', workspaceId: 'same-workspace', hostId: 'local', kind: 'directory', directoryPath: join(root, 'zone'), branch: null }],
    tabs: [{ tabId: 'same-tab', zoneId: 'same-zone', workspaceId: 'same-workspace', name: name + ' original tab', regionIds: ['file', 'agent'] }],
    regions: [{ regionId: 'file', tabId: 'same-tab', kind: 'file', agentSessionId: null, runId: null, execution: null,
      file: { workspaceId: 'same-workspace', path: 'zone/original.note.md', zoneRelativePath: 'original.note.md' } },
    { regionId: 'agent', tabId: 'same-tab', kind: 'agent', agentSessionId: 'same-sid', runId: name + '-run', execution: { hostId: 'local', runtimeId: name + '-runtime', cwd: root } }],
    locations: [{ spaceId: 'same-space', zoneId: 'same-zone', workspaceId: 'same-workspace', displayWorkspaceId: 'same-display', groupId: 'same-group', tabId: 'same-tab', regionId: 'agent' }],
    bindings: [{ spaceId: 'same-space', zoneId: 'same-zone' }], agentPresentation: [{ agentSessionId: 'same-sid', name: name + ' Agent', project: name, detail: '', group: 'results', state: 'done', providerId: 'codex', recap: null }] }
  const workspace = { id: 'same-workspace', hostId: 'local', name, path: root, kind: 'folder' }
  const fileOwner = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, catalog: async () => catalog })
  const service = new AgentMuxRpcService({ files: fileOwner, execute: async () => ({ operation: 'space.ls', catalog } as never), coreClients: () => [] })
  let directory = () => service.call('space.ls', { target: {} })
  const rpc = vi.fn(async (method: string, params: any) => {
    if (method === 'space.ls' || method === 'space.inspect') return directory()
    if (method === 'app.snapshot') return { workspaces: [{ ...workspace, workspaceId: workspace.id }] }
    if (method === 'notebook.inspect') return { resourceChanges: [] }
    return service.call(method as never, params)
  })
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: name + '-runtime' }), onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  return { client, rpc, catalog, files, fileOwner, workspace, root, setDirectory: (read: typeof directory) => { directory = read },
    reads: vi.spyOn(files, 'read'), writes: vi.spyOn(files, 'write') }
}

it('the actual Zone reader retains A file, editor and draft while B is pending or rejected, and never gives B an A read or open', async () => {
  const a = await owner('A'), b = await owner('B'), opened = vi.fn(), create = vi.fn(), menu = vi.fn<(value: MobileAgentMenuTarget) => void>()
  if (process.env.MOBILE_ZONE_CAPTURE_ENTRY && process.env.MOBILE_ZONE_PROOF) {
    const server = new AgentMuxControlServer({ socketPath: join(a.root, 'zone.sock'), files: a.fileOwner,
      execute: async () => ({ operation: 'space.ls', catalog: a.catalog } as never), coreClients: () => [] })
    await server.start(); cleanup.push(() => server.stop())
    const input = join(process.env.MOBILE_ZONE_PROOF, 'capture-input.json')
    await writeFile(input, JSON.stringify({ socket: server.path, workspace: { ...a.workspace, workspaceId: a.workspace.id } }, null, 2))
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [process.env.MOBILE_ZONE_CAPTURE_ENTRY!, '--label', process.env.MOBILE_ZONE_CAPTURE_LABEL ?? 'zone-scope', '--input', input], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk)
      child.on('exit', code => resolve({ code, stdout, stderr }))
    })
    await writeFile(join(process.env.MOBILE_ZONE_PROOF, 'capture.stdout.log'), result.stdout)
    await writeFile(join(process.env.MOBILE_ZONE_PROOF, 'capture.stderr.log'), result.stderr)
    expect(result.code, result.stderr).toBe(0); return
  }
  const render = (client: AgentMuxHostedClient) => <ClientUiProvider platform={createBrowserPlatform()}><MobileAgentMenuContext.Provider value={menu}>
    <MobileZoneWorkface client={client} zoneId="same-zone" name="Original scope" visible openSession={opened} onCreateAgent={create} />
  </MobileAgentMenuContext.Provider></ClientUiProvider>
  const view = await mount(render(a.client))
  await settled(() => expect(view.element.textContent).toContain('A ORIGINAL FILE'))
  await click(button(view.element, '编辑原笔记'))
  const node = await waitForElement<HTMLElement & { editor: Editor }>(view.element, '.mobile-note-body[contenteditable=true]')
  await act(async () => node.editor.commands.insertContentAt(1, 'A RETAINED DRAFT '))
  await settled(() => expect([...Array(localStorage.length)].some((_, i) => localStorage.getItem(localStorage.key(i)!)?.includes('A RETAINED DRAFT'))).toBe(true))
  const range = document.createRange(); range.selectNodeContents(node)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const selection = window.getSelection()!.toString()
  await click(await waitForElement(view.element, '.mobile-agent-row__more'))
  const originalMenu = menu.mock.calls.at(-1)![0]
  const pending = deferred<{ catalog: AgentMuxSpaceCatalog }>()
  b.setDirectory(() => pending.promise as never)
  await view.render(render(b.client))
  expect(b.rpc.mock.calls.filter(([method]) => method === 'app.snapshot'), 'B must not query A retained resource through the current Source').toHaveLength(0)
  expect(view.element.querySelector('.mobile-note-body[contenteditable=true]')).toBe(node)
  expect(node.editor.getText()).toContain('A RETAINED DRAFT')
  expect(range.commonAncestorContainer).toBe(node); expect(window.getSelection()!.toString()).toBe(selection)
  await click(button(view.element, '刷新文件'))
  await settled(() => expect(a.reads).toHaveBeenCalledTimes(2))
  expect(b.rpc.mock.calls.filter(([method]) => method === 'file.read'), 'B must not read A retained file while B directory is pending').toHaveLength(0)
  await click(await waitForElement(view.element, '.mobile-agent-row__open'))
  expect(opened, 'A stale row cannot be opened through current B Source').not.toHaveBeenCalled()
  expect(originalMenu.beforeAction?.()).toBe(false)
  originalMenu.location!.onChoose(a.catalog.locations[0]!)
  expect(opened).not.toHaveBeenCalled()
  await act(async () => pending.reject(Error('B original directory rejected')))
  expect(view.element.querySelector('.mobile-note-body[contenteditable=true]')).toBe(node)
  expect(node.editor.getText()).toContain('A RETAINED DRAFT')
  expect(range.commonAncestorContainer).toBe(node); expect(window.getSelection()!.toString()).toBe(selection)
  await click(button(view.element, '刷新文件')); await settled(() => expect(a.reads).toHaveBeenCalledTimes(3))
  expect(b.reads).not.toHaveBeenCalled(); expect(b.writes).not.toHaveBeenCalled()
  b.setDirectory(async () => ({ catalog: b.catalog } as never))
  await click(button(view.element, '刷新讨论'))
  await settled(() => expect(view.element.textContent).toContain('B ORIGINAL FILE'))
  expect(view.element.querySelector('.mobile-note-body')).not.toBe(node)
  expect(view.element.textContent).not.toContain('A RETAINED DRAFT')
  await click(await waitForElement(view.element, '.mobile-agent-row__open'))
  expect(opened).toHaveBeenLastCalledWith('same-sid', expect.objectContaining({ name: 'B Agent' }))
  await view.render(render(a.client))
  await settled(() => expect(view.element.textContent).toContain('A RETAINED DRAFT'))
  const late = deferred<{ catalog: AgentMuxSpaceCatalog }>(); b.setDirectory(() => late.promise as never)
  await view.render(render(b.client)); await view.render(render(a.client))
  await settled(() => expect(view.element.textContent).toContain('A RETAINED DRAFT'))
  await act(async () => late.resolve({ catalog: b.catalog }))
  expect(view.element.textContent).toContain('A RETAINED DRAFT'); expect(view.element.textContent).not.toContain('B Agent')
  expect(a.writes).not.toHaveBeenCalled(); expect(b.writes).not.toHaveBeenCalled()
  if (process.env.MOBILE_ZONE_PROOF) await writeFile(join(process.env.MOBILE_ZONE_PROOF, 'consumer.json'), JSON.stringify({
    passed: true, originalReads: a.reads.mock.calls.length, acceptedBReads: b.reads.mock.calls.length,
    writes: a.writes.mock.calls.length + b.writes.mock.calls.length, originalEditorRetainedAcrossPendingAndRejection: true,
    originalDraftRestoredAfterB: true, callbackSources: opened.mock.calls.map(([, identity]) => identity.name),
    selection: { qualification: 'Programmatic original DOM Range, not a physical touch selection', nonempty: selection.length > 0, retainedAcrossPendingAndReject: true },
    identityNamespaceCollision: ['space', 'zone', 'tab', 'region', 'workspace', 'session', 'note'],
    calls: { a: a.rpc.mock.calls.map(([method, params]) => ({ method, params })), b: b.rpc.mock.calls.map(([method, params]) => ({ method, params })) }
  }, null, 2) + '\n')
})

it('the accepted query owns its original Zone Tab Region and expected Agent until a later exact query succeeds', async () => {
  const a = await owner('A'), open = vi.fn(), requests: any[] = [], pending = deferred<any>()
  const forward = a.client.forwardRpc!
  a.client.forwardRpc = (async (method, params, ...args) => {
    requests.push({ method, params })
    if ((method === 'space.ls' || method === 'space.inspect') && requests.filter(r => r.method === 'space.ls' || r.method === 'space.inspect').length > 1) return pending.promise
    return forward(method, params, ...args)
  }) as typeof forward
  const render = (zoneId?: string, tabId?: string, regionId?: string) => <ClientUiProvider platform={createBrowserPlatform()}>
    <MobileZoneWorkface client={a.client} zoneId={zoneId} tabId={tabId} regionId={regionId} name="Current query" visible openSession={open} />
  </ClientUiProvider>
  const view = await mount(render('same-zone', 'same-tab', 'agent'))
  await waitForElement(view.element, '.mobile-agent-row__open')
  await view.render(render(undefined, 'next-tab', 'next-region'))
  expect(view.element.textContent, 'Pending selectors cannot filter the accepted original query into a false empty view').toContain('A Agent')
  await click(await waitForElement(view.element, '.mobile-agent-row__open')); expect(open).not.toHaveBeenCalled()
  expect(requests.filter(r => r.method === 'space.inspect')).toEqual([{ method: 'space.inspect', params: { target: { tabId: 'next-tab' }, presentation: true } }])
  await act(async () => pending.resolve({ catalog: { ...a.catalog, tabs: [] } }))
  expect(view.element.textContent).toContain('此 Topic 暂无讨论')
  expect(open).not.toHaveBeenCalled()
})
