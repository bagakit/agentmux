import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolkitScriptSnapshot, ToolkitToolFields } from '@agentmux/core/control'
import { unwrapSessionObservationResult } from '../src/shared/session-observation-result.js'
import type { SessionAttachResult } from '../src/shared/contracts.js'
import { nativeMain, oneCli, until, record } from './toolkit-main.fixture.js'

const program = `exec "$1" -e 'process.stdin.setRawMode(true);process.stdout.write("x".repeat(70000)+"\\x1b[2J\\x1b[HREADY\\r\\n");process.stdin.on("data",b=>process.stdout.write("INPUT:"+b.toString()+"\\r\\n"));setInterval(()=>{},1000)'`
async function stop(main: Awaited<ReturnType<typeof nativeMain>>, executionId: string) {
  const input = join(main.directory, 'stop.json')
  await writeFile(input, JSON.stringify({ executionId }))
  await oneCli('toolkit', 'stop', 'interactive', '--input', input)
}
const inspect = async (id = 'interactive'): Promise<ToolkitScriptSnapshot> => (await oneCli('toolkit', 'inspect', id)).result.snapshot
async function add(main: Awaited<ReturnType<typeof nativeMain>>, id = 'interactive') {
  const fields: ToolkitToolFields = { name: 'Interactive tool', icon: 'terminal', mode: 'tui', enabled: true,
    statusBar: 'label', workspacePath: join(main.directory, 'work'), script: program, args: [process.execPath] }
  const input = join(main.directory, `${id}.json`)
  await writeFile(input, JSON.stringify(fields))
  const definition = (await oneCli('toolkit', 'create', id, '--input', input)).result.definition
  await until(async () => expect(await inspect(id)).toMatchObject({ state: 'running', admission: { definition: { mode: 'tui' } } }))
  return definition
}

it('loads a real TUI through public CLI and shares the ordinary terminal attachment, input and replay', async () => {
  const main = await nativeMain()
  const definition = await add(main)
  const snapshot = await inspect(), execution = snapshot.admission!, run = execution.run!
  const control = { kind: 'terminal' as const, hostId: run.hostId, runId: run.runId, run: { runId: run.runId } }
  expect((await oneCli('toolkit', 'ls')).result.tools).toContainEqual(expect.objectContaining({ toolId: 'interactive', mode: 'tui' }))
  const scan = vi.spyOn(main.core, 'listRuns')
  await inspect()
  expect(scan).not.toHaveBeenCalled()
  scan.mockRestore()
  await until(async () => expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.latestOutputBytes).toBeGreaterThan(70000))
  expect(await inspect()).toMatchObject({ state: 'running', admission: { text: '', run } })
  expect((await inspect()).admission).not.toHaveProperty('document')
  const metadata = await main.invoke('sessions:refresh', control)
  expect(metadata).toMatchObject({ kind: 'terminal', control, processState: 'running' })
  const first = unwrapSessionObservationResult<SessionAttachResult>(await main.invoke('sessions:attach', control, 0))
  expect(first.session.control).toEqual(control)
  expect(first.terminal).toBeTruthy()
  await main.invoke('sessions:resize', first.attachmentId, 92, 28)
  await main.invoke('sessions:write', control, 'hello', 'user')
  await until(async () => {
    const replay = await main.core.readRunReplay({ runId: run.runId }, 0, 'raw')
    expect(replay.replay.map(chunk => new TextDecoder().decode(chunk.dataBytes)).join('')).toContain('INPUT:hello')
  })
  await main.invoke('sessions:detach', first.attachmentId)
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).toBe('running')
  const reopened = unwrapSessionObservationResult<SessionAttachResult>(await main.invoke('sessions:attach', control, 0))
  expect(reopened.session.control).toEqual(control)
  await main.invoke('sessions:detach', reopened.attachmentId)
  const changed = join(main.directory, 'changed.json')
  await writeFile(changed, JSON.stringify({ changes: { mode: 'script', enabled: false, script: 'console.log("next")' }, expected: { mode: 'tui', enabled: true, script: program } }))
  await oneCli('toolkit', 'update', 'interactive', '--input', changed)
  expect(await inspect()).toMatchObject({ definition: { mode: 'script', enabled: false }, admission: { executionId: execution.executionId, definition: { mode: 'tui', revision: definition.revision }, run } })
  await stop(main, execution.executionId)
  await until(async () => expect(await inspect()).toMatchObject({ admission: null, latestConfirmed: { run, state: 'stopped', text: '' } }))
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).not.toBe('running')
  await record('tui-public-terminal', { definition, originalRun: run, originalExecution: execution.executionId, reopenedRun: reopened.session.control.run, outputOverBudget: true, terminalRetained: true })
})

it('normal Main disposal and reconstruction reconnects the exact TUI and does not restart on configuration saves', async () => {
  const main = await nativeMain()
  await add(main)
  const original = (await inspect()).admission!
  await main.restart()
  await until(async () => expect(await inspect()).toMatchObject({ state: 'running', admission: { executionId: original.executionId, run: original.run } }))
  const before = await main.core.listRuns()
  const path = join(main.directory, 'name.json')
  await writeFile(path, JSON.stringify({ changes: { statusBar: 'icon' } }))
  await oneCli('toolkit', 'update', 'interactive', '--input', path)
  expect((await main.core.listRuns()).map(run => run.runId)).toEqual(before.map(run => run.runId))
  expect((await inspect()).admission!.run).toEqual(original.run)
  await stop(main, original.executionId)
  await until(async () => expect((await inspect()).admission).toBeNull())
  const ended = (await inspect()).latestConfirmed!
  await inspect()
  expect((await main.core.listRuns()).map(run => run.runId)).toEqual(before.map(run => run.runId))
  await main.restart()
  await until(async () => expect((await inspect()).admission?.run?.runId).toBeTruthy())
  const fresh = (await inspect()).admission!
  expect(fresh.run).not.toEqual(original.run)
  expect((await inspect()).latestConfirmed?.executionId).toBe(ended.executionId)
  await record('tui-owner-recovery', { original: original.run, reconnected: original.run, nextLoad: fresh.run, originalExecution: original.executionId })
})
