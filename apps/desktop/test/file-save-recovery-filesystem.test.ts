import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import type { WorkspaceRecord } from '../src/shared/contracts'

const initial = useAppStore.getState(), roots: string[] = []
afterEach(async () => { useAppStore.setState(initial, true); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('ordinary file owner serializes two stale revisions without replacing unrelated content', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'file-save-cas-'))); roots.push(home)
  const workspace: WorkspaceRecord = { id: 'ordinary-files', path: home, hostId: 'local', name: 'Files', kind: 'folder' }
  await mkdir(workspace.path, { recursive: true })
  const path = 'decisions.md'
  const original = 'Scope: Project A\nSource: discussion A\nKeep this unrelated decision.\nCorrect this preference.\n'
  await writeFile(join(workspace.path, 'decisions.md'), original)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const read = await files.read(workspace, path)
  expect(read.status).toBe('read'); if (read.status !== 'read') throw new Error('Real source did not load')
  const corrected = original.replace('Correct this preference.', 'This preference applies only to Project A.')
  const results = await Promise.all([
    files.write(workspace, { path, content: corrected, expectedRevision: read.document.revision }),
    files.write(workspace, { path, content: original.replace('Correct this preference.', ''), expectedRevision: read.document.revision })
  ])
  expect(results.map(result => result.status)).toEqual(['written', 'conflict'])
  expect(await readFile(join(workspace.path, 'decisions.md'), 'utf8')).toBe(corrected)
  expect((await files.read(workspace, path))).toMatchObject({ status: 'read', document: { path, content: corrected } })
  await files.dispose()
})

it.each([false, true])('actual published lost receipt is checked through ordinary Store and file owner (later edit: %s)', async laterEdit => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'file-save-receipt-'))); roots.push(home)
  const workspace: WorkspaceRecord = { id: 'ordinary-files', path: home, hostId: 'local', name: 'Files', kind: 'folder' }
  await mkdir(workspace.path, { recursive: true })
  const path = 'preferences.txt', bytes = 'Keep the source.\nWithdraw the obsolete preference.\n'
  await writeFile(join(workspace.path, 'preferences.txt'), bytes)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { localWriteFault: 'receipt' })
  const opened = await files.read(workspace, path)
  expect(opened.status).toBe('read'); if (opened.status !== 'read') throw new Error('Real source did not load')
  const id = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(id), key = documentKey(workspace.id, path)
  const tab = createWorkbenchTab(id, { kind: 'file', regionId, workspaceId: workspace.id, path })
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    tabs: { [id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('group', [id]) },
    documents: { [key]: opened.document }, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, savingDocuments: {} })
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (workspaceId, input) => { expect(workspaceId).toBe(workspace.id); return files.write(workspace, input) })
  vi.spyOn(api.files, 'read').mockImplementation(async (workspaceId, source) => { expect(workspaceId).toBe(workspace.id); return files.read(workspace, source) })
  const withdrawn = bytes.replace('Withdraw the obsolete preference.\n', '')
  useAppStore.getState().updateDocument(id, withdrawn, regionId)
  await useAppStore.getState().saveDocument(id, regionId)
  expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
  expect(await readFile(join(workspace.path, 'preferences.txt'), 'utf8')).toBe(withdrawn)
  await useAppStore.getState().saveDocument(id, regionId); expect(write).toHaveBeenCalledTimes(1)
  if (laterEdit) useAppStore.getState().updateDocument(id, withdrawn + 'Later draft.\n', regionId)
  await useAppStore.getState().reloadDocument(id, regionId)
  expect(write).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().documents[key]?.content).toBe(laterEdit ? withdrawn + 'Later draft.\n' : withdrawn)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(laterEdit)
  expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  expect(useAppStore.getState().tabs[id]).toBe(tab)
  await files.dispose()
})
