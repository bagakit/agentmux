import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import type { AppWindowOperation } from '@agentmux/core/control'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-window-store-')); directories.push(directory)
  const path = join(directory, 'windows.json')
  return { directory, path, store: new WorkbenchWindowStore(path) }
}
const state = { mainWindowId: 'original-main', windows: [{ windowId: 'original-window', target: { kind: 'region' as const, displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }, geometry: { x: -300, y: 50, width: 800, height: 600, maximized: false } }] }
const operation: AppWindowOperation = { method: 'app.window.open', input: { operationId: 'original/operation', target: state.windows[0]!.target }, actor: { kind: 'user', id: 'desktop' }, state: 'pending', windowId: 'original-window', documentGeneration: null, message: null }

it('durably restores original presentation identities and geometry without inventing a Run', async () => {
  const f = await fixture()
  await f.store.save(state); await f.store.flush()
  expect(await new WorkbenchWindowStore(f.path).load()).toEqual({ state, issue: null, writable: true })
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ schema: 'agentmux.workbench-windows.v1', ...state })
})
it.each(['{broken', JSON.stringify({ schema: 'agentmux.workbench-windows.v1', ...state, mainWindowId: 'invalid\nidentity' })])('retains unreadable original arrangement bytes and reports only the presentation failure', async bytes => {
  const f = await fixture(); await writeFile(f.path, bytes)
  const read = await f.store.load()
  expect(read.writable).toBe(false); expect(read.issue).toContain('Original workfaces and Agents remain')
  expect(await readFile(f.path, 'utf8')).toBe(bytes)
})
it('reads the exact durable original operation independently of unrelated receipts and preserves unknown bytes', async () => {
  const f = await fixture()
  await f.store.saveOperation(operation)
  expect(await f.store.operation(operation.input.operationId)).toEqual(operation)
  const receipts = join(f.directory, 'workbench-window-operations')
  const unrelated = join(receipts, 'unrelated.json'); await writeFile(unrelated, '{unreadable')
  expect(await f.store.operation(operation.input.operationId)).toEqual(operation)
  expect(await f.store.operation('missing-original')).toBeNull()
  const name = createHash('sha256').update(operation.input.operationId).digest('hex') + '.json'
  expect(await readdir(receipts)).toContain(name)
  await writeFile(join(receipts, name), JSON.stringify({ ...operation, input: { ...operation.input, operationId: 'different-original' } }))
  await expect(f.store.operation(operation.input.operationId)).rejects.toThrow('does not match')
  expect(JSON.parse(await readFile(join(receipts, name), 'utf8')).input.operationId).toBe('different-original')
})
