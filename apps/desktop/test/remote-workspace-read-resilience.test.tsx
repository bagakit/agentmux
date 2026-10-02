import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { LauncherFileReferences } from '../src/renderer/src/components/LauncherFileReferences'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { remoteDirectoryFixture } from './helpers/remote-directory-fixture'

const dom = composerDOM(), bridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
let f: Awaited<ReturnType<typeof remoteDirectoryFixture>>
beforeEach(async () => {
  f = await remoteDirectoryFixture()
  vi.stubEnv('PATH', f.bin + ':' + process.env.PATH); vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_TRACE', f.trace)
  await writeFile(join(f.path, 'original.md'), 'original')
  useAppStore.setState({ config: { ...composerConfig, workspaces: [f.workspace] }, activeWorkspaceId: f.workspace.id,
    tabs: {}, layouts: {}, pinnedItems: {}, fileExplorerStates: {}, workspaceFileRevisions: {}, lastActiveFileByWorkspace: {},
    dirtyDocuments: {}, scratchTopicSnapshots: {}, agentComposerDrafts: { original: 'Keep my unsent draft' } })
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status: async () =>
    ({ kind: 'not-a-git-repository', hostId: f.host.id, workspacePath: f.path }) } } })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, path) => {
    const workspace = useAppStore.getState().config!.workspaces.find(value => value.id === id)!
    return await f.files.readDirectory(workspace, path)
  })
})
afterEach(async () => {
  if (bridge) Object.defineProperty(window, 'agentmux', bridge); else Reflect.deleteProperty(window, 'agentmux')
  vi.unstubAllEnvs(); await f.dispose()
})
const waitForRead = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10000 })
const refRow = () => document.querySelector('[data-reference-path="original.md"]')
const click = async (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector)
  expect(button, 'The original recovery action must remain mounted').not.toBeNull()
  await act(async () => button!.click())
}
const retry = async () => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === 'Retry')
  expect(button, 'The original target must have a reachable Retry').toBeDefined()
  await act(async () => button!.click())
}

it('Launcher retains same-resource files throughout a pending refresh, timeout and successful Retry', async () => {
  await dom.render(<LauncherFileReferences workspace={f.workspace} onSelect={() => {}} onClose={() => {}} />)
  await waitForRead(() => expect(refRow()).not.toBeNull())
  let fail!: (error: Error) => void
  vi.spyOn(f.host, 'run').mockImplementationOnce(async () => await new Promise((_resolve, reject) => { fail = reject }))
  await click('[aria-label="Refresh project files"]')
  expect(refRow(), 'Known files must stay visible during the same-resource refresh').not.toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Refreshing')
  await act(async () => fail(new AgentMuxError('Command timed out.', 'COMMAND_TIMEOUT')))
  expect(refRow(), 'A failed original directory observation must keep its known files').not.toBeNull()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(f.path)
  await writeFile(join(f.path, 'later.md'), 'later')
  await retry()
  await waitForRead(() => expect(document.querySelector('[data-reference-path="later.md"]')).not.toBeNull())
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep my unsent draft')
}, 15000)

it('Launcher excludes old files and late results when the same Workspace changes original Host or root', async () => {
  await dom.render(<LauncherFileReferences workspace={f.workspace} onSelect={() => {}} onClose={() => {}} />)
  await waitForRead(() => expect(refRow()).not.toBeNull())
  let complete!: (value: Awaited<ReturnType<typeof api.files.readDirectory>>) => void
  vi.mocked(api.files.readDirectory).mockImplementationOnce(async () => await new Promise(resolve => { complete = resolve }))
  await click('[aria-label="Refresh project files"]')
  const replacement = { ...f.workspace, hostId: 'replacement-host', path: _hygiene_fixturePath("replacement/project") }
  vi.mocked(api.files.readDirectory).mockResolvedValueOnce([{ name: 'replacement.md', path: 'replacement.md', isDirectory: false, isSymlink: false }])
  await dom.render(<LauncherFileReferences workspace={replacement} onSelect={() => {}} onClose={() => {}} />)
  expect(refRow(), 'Changed resources must never display the old resource files').toBeNull()
  await act(async () => complete([{ name: 'old-late.md', path: 'old-late.md', isDirectory: false, isSymlink: false }]))
  expect(document.querySelector('[data-reference-path="old-late.md"]')).toBeNull()
  expect(document.querySelector('[data-reference-path="replacement.md"]')).not.toBeNull()
}, 15000)

it('Explorer keeps known rows and its original-target Retry after a real owner read failure', async () => {
  await dom.render(<FileExplorer workspaceId={f.workspace.id} />)
  await waitForRead(() => expect(document.querySelector('[data-tree-path="original.md"]')).not.toBeNull())
  vi.spyOn(f.host, 'run').mockRejectedValueOnce(new AgentMuxError('Command timed out.', 'COMMAND_TIMEOUT'))
  await click('[title="Refresh explorer"]')
  await waitForRead(() => expect(document.querySelector('.tree-empty--error')).not.toBeNull())
  expect(document.querySelector('[data-tree-path="original.md"]'), 'The original readable tree must stay usable').not.toBeNull()
  await writeFile(join(f.path, 'after.md'), 'after')
  await retry()
  await waitForRead(() => expect(document.querySelector('[data-tree-path="after.md"]')).not.toBeNull())
  expect(document.querySelector('.tree-empty--error')).toBeNull()
}, 15000)

it('Explorer rejects an older observation after the same Workspace changes execution resources', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.readDirectory>>) => void
  vi.mocked(api.files.readDirectory).mockImplementationOnce(async () => await new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer workspaceId={f.workspace.id} />)
  vi.mocked(api.files.readDirectory).mockResolvedValueOnce([{ name: 'new.md', path: 'new.md', isDirectory: false, isSymlink: false }])
  await act(async () => useAppStore.setState({ config: { ...composerConfig,
    workspaces: [{ ...f.workspace, hostId: 'new-execution', path: _hygiene_fixturePath("new-resource") }] } }))
  await waitForRead(() => expect(document.querySelector('[data-tree-path="new.md"]')).not.toBeNull())
  await act(async () => complete([{ name: 'old.md', path: 'old.md', isDirectory: false, isSymlink: false }]))
  expect(document.querySelector('[data-tree-path="old.md"]'), 'Old execution facts must not enter the replacement resource').toBeNull()
  expect(document.querySelector('[data-tree-path="new.md"]')).not.toBeNull()}, 15000)
