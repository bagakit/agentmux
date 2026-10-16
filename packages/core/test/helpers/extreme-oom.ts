import { once } from 'node:events'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import * as core from '../../dist/index.js'
import { processWitness, type extremeFixture } from './extreme-event-fixture.js'

/** Fatal managed-heap exhaustion after the original healthy checkpoint. */
export async function exhaustOwnedSemantic(f: Awaited<ReturnType<typeof extremeFixture>>) {
  const originalOwner = f.scope.owner
  const child = f.scope.ownerProcess, witness = await processWitness(child.pid!)
  expect(witness).toMatchObject({ pid: f.scope.owner.processId, command: expect.stringContaining('--max-old-space-size=96') })
  expect(witness.parent).toBe(process.pid)
  const filePaths = [f.store.path, join(f.state, 'semantic-runtime.json'), join(f.state, 'spatial-state.json'), f.nativePath]
  const files = await Promise.all(filePaths.map(async path => { const value = await stat(path); return { path, dev: value.dev, ino: value.ino } }))
  let fatal = ''; child.stderr!.on('data', data => { fatal += String(data) })
  const exit = once(child, 'exit')
  // Recheck birth/owner immediately before arming this one bounded child.
  expect({ ...await processWitness(child.pid!), state: witness.state }).toEqual(witness)
  await writeFile(join(f.state, 'actual-heap-exhaustion'), JSON.stringify({ pid: witness.pid }))
  const [code, signal] = await exit
  expect(fatal, 'must be a real V8 fatal heap exhaustion, not an injected throw or SIGKILL').toMatch(/FATAL ERROR:.*(?:heap out of memory|heap limit)/u)
  expect(signal).toBe('SIGABRT'); expect(code).toBeNull()
  const entered = JSON.parse(await readFile(join(f.state, 'oom-entered.json'), 'utf8'))
  expect(entered).toMatchObject({ pid: witness.pid, limit: ['--max-old-space-size=96', '--max-semi-space-size=4'] })
  expect(entered.heap.used_heap_size).toBeLessThan(96 * 1024 * 1024)
  expect(entered.heap.heap_size_limit).toBeLessThan(160 * 1024 * 1024)
  // Neither descendant is allowed to die in this survival proof.
  for (const original of f.owned.slice(1)) {
    const current = await processWitness(original.pid)
    expect({ ...current, state: original.state }, 'original Native/CLI must survive semantic-owner OOM').toEqual(original)
  }
  const physical = (await f.observer.listRuns()).find(value => value.runId === f.original.run.runId)
  expect(physical).toMatchObject({ state: 'running', pid: f.before.run.pid, acceptedInputBytes: f.before.run.acceptedInputBytes })
  const cold = await f.scope.restart(), nextWitness = await processWitness(f.scope.ownerProcess.pid!)
  f.owned.push(nextWitness)
  expect(cold.owner.processId).not.toBe(witness.pid)
  expect(cold.owner.runtimeId).toBe(originalOwner.runtimeId)
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: cold.socketPath } }); f.cleanups.push(() => rpc.dispose())
  const sdk = await f.scope.client(rpc)
  for (const file of files) {
    const value = await stat(file.path)
    expect({ dev: value.dev, ino: value.ino }, 'cold owner must read the first original files without reseeding').toEqual({ dev: file.dev, ino: file.ino })
  }
  await f.assertOriginal(sdk, rpc)
  console.info('EXTREME_OOM=' + JSON.stringify({ witness, entered, code, signal, fatal, files, newOwner: cold.owner,
    originalRun: f.original.run, originalPid: f.before.run.pid, originalNative: f.native }))
  return { sdk, rpc, fatal, files, witness, newOwner: cold.owner }
}
