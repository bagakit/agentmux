import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { isObjectId } from '@agentmux/identity'
import { openDemandStore } from '../src/demand-store.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function root() { const value = await fs.mkdtemp(join(tmpdir(), 'demand-ids-')); roots.push(value); return value }
async function cli(directory: string, args: string[]) {
  const entry = process.env.AGENTMUX_TEST_DEMAND_CLI || fileURLToPath(new URL('../dist/bin/agentmux-demand.js', import.meta.url))
  return await new Promise<{ code: number | null; output: Record<string, any> }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--root', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', code => { try { resolve({ code, output: JSON.parse(stdout || stderr) }) } catch (error) { reject(error) } })
  })
}

it('compiled Demand CLI emits shared request and operation IDs and retains a supplied historical Goal identity', async () => {
  const directory = await root(), legacy = '8d635382-9086-49b3-825e-f814e87dcb80'
  const created = await cli(directory, ['create', '--id', legacy, '--title', 'Original goal'])
  expect(created.code).toBe(0); expect(isObjectId(created.output.requestId)).toBe(true)
  expect(isObjectId(created.output.receipt.operationId)).toBe(true); expect(created.output.receipt.demand.id).toBe(legacy)
  const listed = await cli(directory, ['list'])
  expect(listed.code).toBe(0); expect(isObjectId(listed.output.requestId)).toBe(true)
  expect(listed.output.demands[0].id).toBe(legacy)
  const failed = await cli(directory, ['show', '--id', 'absent'])
  expect(failed.code).toBe(1); expect(isObjectId(failed.output.requestId)).toBe(true)
  expect(failed.output.error.code).toBe('NOT_FOUND')
})

it('Demand writes use shared temporary and operation IDs without replacing retained operation or participation references on reopen', async () => {
  const directory = await root(), store = openDemandStore({ root: directory })
  const originalOpen = fs.open.bind(fs), candidates: string[] = []
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (args[1] === 'wx' && String(args[0]).includes('.tmp-')) candidates.push(String(args[0]))
    return await originalOpen(...args)
  })
  const source = { kind: 'discussion' as const, agentSessionId: 'old-session', hostId: 'local', entryPoint: 'exact-original-entry' }
  const made = await store.create({ title: 'Goal' }, { participation: source })
  expect(isObjectId(made.operationId)).toBe(true); expect(isObjectId(made.demand.id)).toBe(true)
  const changed = await store.update(made.demand.id, { description: 'Keep original state' }, { participation: source })
  expect(isObjectId(changed.operationId)).toBe(true)
  for (const participation of changed.demand.participations) { expect(isObjectId(participation.id)).toBe(true); expect(isObjectId(participation.operationId)).toBe(true) }
  const old = '94264d72-0709-4fa6-ac8a-40e1a5cb2fd7'
  const renamed = await store.update(made.demand.id, { title: 'Retained title' }, { operationId: old })
  expect(renamed.operationId).toBe(old); expect(renamed.nameChange?.id).toBe(old)
  const reopened = openDemandStore({ root: directory })
  expect((await reopened.get(made.demand.id))?.participations).toEqual(renamed.demand.participations)
  expect((await reopened.listNameChanges(made.demand.id)).records[0]!.operationId).toBe(old)
  expect(candidates.length).toBeGreaterThan(1)
  for (const candidate of candidates) expect(isObjectId(candidate.split('-').at(-1))).toBe(true)
  expect((await fs.readdir(directory)).some(name => name.includes('.tmp-'))).toBe(false)
})
