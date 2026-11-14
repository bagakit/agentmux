import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ToolkitOwner } from '../src/main/toolkit-owner.js'
import { registerToolkitIpc } from '../src/main/toolkit-ipc.js'
import { TOOLKIT_MAX_LISTED_TOOLS, type ToolkitToolDefinition, type ToolkitResult } from '@agentmux/core/control'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function store(ids: () => string[]) {
  const directory = await mkdtemp(_hygiene_fixturePath("tmp/amx-toolkit-receipts-")); directories.push(directory)
  return { file: join(directory, 'receipts.json'), value: new ToolkitReceiptStore(join(directory, 'receipts.json'), ids) }
}

describe('bounded Toolkit durable receipt file', () => {
  it('preserves every legal public catalog receipt across durable reload and rejects excess identities', async () => {
    const ids = Array.from({ length: TOOLKIT_MAX_LISTED_TOOLS }, (_, index) => `tool-${index}`)
    const s = await store(() => ids)
    await Promise.all(ids.map(id => s.value.save(id, { admission: { invocationId: id } })))
    const restored = new ToolkitReceiptStore(s.file, () => ids)
    for (const id of ids) expect(await restored.read(id)).toEqual({ admission: { invocationId: id } })
    expect(Object.keys(JSON.parse(await readFile(s.file, 'utf8')).tools)).toEqual(ids)
    await expect(s.value.save('excess', { admission: null })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(Object.keys(JSON.parse(await readFile(s.file, 'utf8')).tools)).toEqual(ids)
  })
  it('builds entries in the real write queue and preserves both concurrent tool admissions including own prototype keys', async () => {
    const s = await store(() => ['__proto__', 'two'])
    const one = { admission: { invocationId: 'one' }, latestConfirmed: null }, two = { admission: { invocationId: 'two' }, latestConfirmed: null }
    await Promise.all([s.value.save('__proto__', one), s.value.save('two', two)])
    const restored = new ToolkitReceiptStore(s.file, () => ['__proto__', 'two'])
    expect(await restored.read('__proto__')).toEqual(one); expect(await restored.read('two')).toEqual(two)
    const disk = JSON.parse(await readFile(s.file, 'utf8'))
    expect(Object.keys(disk.tools)).toEqual(['__proto__', 'two']); expect(Object.hasOwn(disk.tools, '__proto__')).toBe(true)
  })
  it('prunes removed configuration identities on the next keypoint without retaining a result history', async () => {
    let ids = ['one', 'two']; const s = await store(() => ids)
    await s.value.save('one', { old: true }); await s.value.save('two', { old: true })
    ids = ['two']; await s.value.save('two', { new: true })
    expect(await s.value.read('one')).toBeNull(); expect(await s.value.read('two')).toEqual({ new: true })
    expect(Object.keys(JSON.parse(await readFile(s.file, 'utf8')).tools)).toEqual(['two'])
  })
  it('limits a corrupted record to its tool, with no whole-library restoration or script execution', async () => {
    const s = await store(() => ['bad', 'good'])
    await s.value.save('bad', { admission: 'corrupt', latestConfirmed: null })
    await s.value.save('good', { admission: null, latestConfirmed: null })
    const base: ToolkitToolDefinition = { id: 'bad', revision: 'revision', name: 'Tool', icon: 'terminal', enabled: true,
      statusBar: 'icon', workspacePath: _hygiene_fixturePath("tmp"), script: "console.log('ACK')", args: [] }
    const config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [base, { ...base, id: 'good' }] } }
    const owner = new ConfigOwner({ read: () => config, save: async next => next, publish: () => {} })
    const open = vi.fn(async () => { throw new Error('No script admission was authorized.') })
    const tools = new CustomToolkitOwner({ config: owner, receipts: s.value, runner: process.execPath, env: {}, openRunPort: open })
    expect(await tools.get('bad')).toMatchObject({ state: 'unknown', latestConfirmed: null })
    expect(await tools.get('good')).toMatchObject({ state: 'idle', latestConfirmed: null, reason: null })
    expect(open).not.toHaveBeenCalled()
    await tools.dispose()
  })
  it('rereads the original file in the same Main owners after a temporary filesystem read error', async () => {
    const definition: ToolkitToolDefinition = { id: 'local-tui', revision: 'original-revision', name: 'Terminal', icon: 'terminal',
      mode: 'tui', enabled: true, autoStart: false, statusBar: 'icon', workspacePath: _hygiene_fixturePath("tmp"), script: '', args: [] }
    const performanceRun = { hostId: 'local', runId: 'original-performance-run' }
    const { file, value } = await store(() => [definition.id, 'performance'])
    await value.save(definition.id, { latestConfirmed: null, admission: {
      definition, executionId: 'original-tui-request', invocationId: 'original-invocation', expectedLatestExecutionId: null,
      target: { workspacePath: definition.workspacePath }, run: null, startedAt: 1000, text: '', state: 'unknown', reason: 'Original TUI launch receipt was missing.'
    } })
    await value.save('performance', { schema: 'agentmux.performance.receipt.v1', admission: {
      executionId: 'original-performance-request', run: performanceRun, startedAt: 1000, reason: 'Original Performance observation.'
    } })
    const retained = file + '.held'
    // EISDIR at the exact receipt path, while the original byte image remains intact.
    await rename(file, retained)
    await mkdir(file)
    const config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [definition] } }
    const configuration = new ConfigOwner({ read: () => config, save: async next => next, publish: () => {} })
    const openRunPort = vi.fn(async () => { throw new Error('A read must never open a Run.') })
    const owner = new ToolkitOwner({ config: configuration, receiptPath: file, openRunPort, enabled: () => true,
      launch: () => ({ runner: process.execPath, cli: '', script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: definition.workspacePath, env: {} }) })
    let get: ((event: IpcMainInvokeEvent, id: string) => unknown) | undefined
    const detach = registerToolkitIpc(owner, (channel, handler) => { if (channel === 'toolkit:get') get = handler })
    const inspect = async (id: string) => await get!({} as IpcMainInvokeEvent, id) as Extract<ToolkitResult, { operation: 'toolkit.get' }>
    const observed = vi.fn()
    const lease = await owner.subscribe(definition.id, observed, vi.fn(), new AbortController().signal)
    try {
      const missing = await Promise.all([inspect(definition.id), inspect('performance')])
      expect(missing.map(({ snapshot }) => snapshot)).toEqual([
        expect.objectContaining({ state: 'unknown', reason: expect.stringContaining('Tool receipt is unconfirmed') }),
        expect.objectContaining({ state: 'unknown', reason: expect.stringContaining('Performance admission is unconfirmed') })
      ])
      await rmdir(file)
      await rename(retained, file)
      const [tui, performance] = await Promise.all([inspect(definition.id), inspect('performance')])
      expect(tui.snapshot).toMatchObject({ state: 'unknown', reason: 'Original TUI launch receipt was missing.',
        admission: { executionId: 'original-tui-request', run: null } })
      expect(performance.snapshot).toMatchObject({ state: 'unknown', reason: 'Original Performance observation.',
        executionId: 'original-performance-request', run: performanceRun })
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({
        admission: expect.objectContaining({ executionId: 'original-tui-request' })
      }))
      expect(openRunPort).not.toHaveBeenCalled()
    } finally {
      lease.dispose()
      detach()
      await owner.dispose()
    }
  })
})
