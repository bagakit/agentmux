import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } }))
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function store(ids: () => string[]) {
  const directory = await mkdtemp('/tmp/amx-toolkit-receipts-'); directories.push(directory)
  return { file: join(directory, 'receipts.json'), value: new ToolkitReceiptStore(join(directory, 'receipts.json'), ids) }
}

describe('bounded Toolkit durable receipt file', () => {
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
      statusBar: 'icon', workspacePath: '/tmp', script: "console.log('ACK')", args: [] }
    const config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [base, { ...base, id: 'good' }] } }
    const owner = new ConfigOwner({ read: () => config, save: async next => next, publish: () => {} })
    const open = vi.fn(async () => { throw new Error('No script admission was authorized.') })
    const tools = new CustomToolkitOwner({ config: owner, receipts: s.value, runner: process.execPath, env: {}, openRunPort: open })
    expect(await tools.get('bad')).toMatchObject({ state: 'unknown', latestConfirmed: null })
    expect(await tools.get('good')).toMatchObject({ state: 'idle', latestConfirmed: null, reason: null })
    expect(open).not.toHaveBeenCalled()
    await tools.dispose()
  })
})
