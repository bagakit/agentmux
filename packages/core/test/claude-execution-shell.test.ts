import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createClaudeExecutionShell } from '../src/providers/claude-execution-shell.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-resource-shell-'))), workspace = join(root, 'project with spaces')
  await mkdir(workspace)
  const shell = createClaudeExecutionShell({ workspacePath: workspace, outputDirectory: join(root, 'outputs'), env: { SHELL: '/bin/bash' } })
  cleanups.push(async () => { await shell.close(); await rm(root, { recursive: true, force: true }) })
  return { root, workspace, shell }
}
const exists = (path: string) => access(path).then(() => true, () => false)

describe('Claude resource shell under the original execution helper', () => {
  it('executes exact shell source and retains an accurately observed cwd beyond the starting project', async () => {
    const f = await fixture(); await mkdir(join(f.workspace, 'child dir'))
    expect(await f.shell.run({ command: "printf '%s' 'literal;$()'; printf error >&2" })).toMatchObject({ stdout: 'literal;$()', stderr: 'error', interrupted: false })
    await f.shell.run({ command: "cd 'child dir'" })
    expect((await f.shell.run({ command: 'pwd' })).stdout.trim()).toBe(join(f.workspace, 'child dir'))
    const outside = join(f.root, 'other project'); await mkdir(outside)
    await f.shell.run({ command: `cd '${outside}'` })
    expect((await f.shell.run({ command: 'pwd; printf external > exact-target' })).stdout.trim()).toBe(outside)
    expect(await readFile(join(outside, 'exact-target'), 'utf8')).toBe('external')
    expect(await exists(join(f.workspace, 'exact-target'))).toBe(false)
  })

  it('stops the exact live background task and its process group before a delayed effect', async () => {
    const f = await fixture(), started = join(f.workspace, 'started'), effect = join(f.workspace, 'effect')
    const task = await f.shell.run({ command: 'printf started > started; (sleep 0.4; printf effect > effect) & wait', run_in_background: true })
    const child = vi.mocked(spawn).mock.results.at(-1)!.value
    expect(task.backgroundTaskId).toMatch(/^amux-shell-/u)
    await vi.waitFor(async () => expect(await exists(started)).toBe(true))
    const stopped = await f.shell.stop({ task_id: task.backgroundTaskId })
    expect(stopped).toMatchObject({ task_id: task.backgroundTaskId, task_type: 'local_bash' })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(await exists(effect)).toBe(false)
    expect(await readFile(task.backgroundOutputPath!, 'utf8')).toBe('')
  })

  it('auto-backgrounds a slow foreground request without killing its legitimate work', async () => {
    const f = await fixture()
    const task = await f.shell.run({ command: 'sleep 0.1; printf finished > completed; printf output', timeout: 10 })
    expect(task).toMatchObject({ timedOutAfterMs: 10, backgroundTaskId: expect.any(String), backgroundOutputPath: expect.any(String) })
    await vi.waitFor(async () => expect(await exists(join(f.workspace, 'completed'))).toBe(true))
    expect(await readFile(join(f.workspace, 'completed'), 'utf8')).toBe('finished')
    expect(await readFile(task.backgroundOutputPath!, 'utf8')).toBe('output')
    expect((await f.shell.run({ command: 'printf still-usable' })).stdout).toBe('still-usable')
  })

  it('keeps an explicit background command alive beyond its call timeout until an actual stop', async () => {
    const f = await fixture()
    const task = await f.shell.run({ command: 'sleep 0.1; printf continuing > continuing; sleep 2', timeout: 10, run_in_background: true })
    await vi.waitFor(async () => expect(await exists(join(f.workspace, 'continuing'))).toBe(true))
    expect(await readFile(join(f.workspace, 'continuing'), 'utf8')).toBe('continuing')
    await expect(f.shell.stop({ task_id: task.backgroundTaskId })).resolves.toMatchObject({ task_id: task.backgroundTaskId })
  })

  it('keeps the full resource output when the model-facing preview is bounded', async () => {
    const f = await fixture()
    const task = await f.shell.run({ command: 'head -c 60000 /dev/zero | tr "\\0" x' })
    expect(task.stdout.length).toBe(15_000)
    expect(task.rawOutputPath).toBeTruthy()
    expect((await readFile(task.rawOutputPath!)).length).toBe(60_000)
  })

  it('refuses unrelated task identifiers while the original task and ordinary shell remain usable', async () => {
    const f = await fixture()
    const task = await f.shell.run({ command: 'sleep 2', run_in_background: true })
    await expect(f.shell.stop({ task_id: 'not-an-owned-child' })).rejects.toThrow('not running under this execution binding')
    expect((await f.shell.run({ command: 'printf working' })).stdout).toBe('working')
    await expect(f.shell.stop({ shell_id: task.backgroundTaskId })).resolves.toMatchObject({ task_id: task.backgroundTaskId })
  })

  it('ends only owned children on explicit helper shutdown and prevents later launches', async () => {
    const f = await fixture()
    await f.shell.run({ command: 'sleep 0.3; printf forbidden > after-close', run_in_background: true })
    await f.shell.close()
    await expect(f.shell.run({ command: 'printf forbidden > new-child' })).rejects.toThrow('owner is closed')
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(await exists(join(f.workspace, 'after-close'))).toBe(false)
    expect(await exists(join(f.workspace, 'new-child'))).toBe(false)
  })
})
