import { describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'
import { nativeMain, until, oneCli, cli, record } from './toolkit-main.fixture.js'

async function inspect(id: string): Promise<ToolkitScriptSnapshot> {
  const value = (await oneCli('toolkit', 'inspect', id)).result.snapshot
  return value.kind === 'package-unavailable' ? value.retained : value
}
const displayScript = "import {appendFile} from 'node:fs/promises'; await appendFile('display-count','1'); process.stdout.write('current_'+process.argv.at(-1))"

describe('display Toolkit actual Main CLI and Native', () => {
  it.each(['inline', 'package'] as const)('evaluates %s current data while preserving the original unknown through owner restart', async kind => {
    const m = await nativeMain(), id = 'display-current'
    const ordinary = "import {appendFile} from 'node:fs/promises'; await appendFile('ordinary-count','1'); process.stdout.write('ordinary_result')"
    if (kind === 'inline') {
      const input = join(m.directory, 'tool.json')
      await writeFile(input, JSON.stringify({ name: 'Current data', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: join(m.directory, 'work'),
        script: ordinary, args: [], display: { script: displayScript, args: ['from_inline'] } }))
      await oneCli('toolkit', 'create', id, '--input', input)
    } else {
      const directory = join(m.directory, 'package'); await mkdir(directory)
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Current data', icon: 'terminal',
        entry: 'ordinary.mjs', display: { entry: 'display.mjs', args: ['from_package'] } }))
      await writeFile(join(directory, 'ordinary.mjs'), ordinary); await writeFile(join(directory, 'display.mjs'), displayScript)
      await oneCli('toolkit', 'install', id, '--path', directory, '--cwd', join(m.directory, 'work'))
    }
    const originalPort = m.runtime.toolkitRunPort.bind(m.runtime)
    const lose = vi.spyOn(m.runtime, 'toolkitRunPort').mockImplementation(async () => {
      const port = await originalPort()
      return { ...port, create: async (input, listener) => { await port.create(input, listener); throw new Error('lost-original-ordinary-reply') } }
    })
    await oneCli('toolkit', 'run', id); lose.mockRestore()
    const previous = await inspect(id)
    expect(previous).toMatchObject({ state: 'unknown', admission: { run: null } })
    await until(async () => expect(await readFile(join(m.directory, 'work/ordinary-count'), 'utf8')).toBe('1'))
    await oneCli('toolkit', 'evaluate', id)
    let current!: ToolkitScriptSnapshot
    await until(async () => { current = await inspect(id); expect(current.display?.state).toBe('succeeded'); expect(current.display?.admission).toBeNull() })
    expect(current.admission).toEqual(previous.admission)
    expect(current.display!.latestConfirmed!.text).toBe('current_from_' + kind)
    expect(current.display!.latestConfirmed!.executionId).not.toBe(previous.admission!.executionId)
    const instance = await m.sdk.daemonInstance(); await m.restart()
    expect(await m.sdk.daemonInstance()).toBe(instance)
    const restored = await inspect(id)
    expect(restored.admission).toMatchObject({ executionId: previous.admission!.executionId, invocationId: previous.admission!.invocationId, run: null, state: 'unknown' })
    expect(restored.display!.latestConfirmed).toEqual(current.display!.latestConfirmed)
    expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('1')
    await oneCli('toolkit', 'evaluate', id)
    await until(async () => expect((await inspect(id)).display!.latestConfirmed!.executionId).not.toBe(current.display!.latestConfirmed!.executionId))
    expect(await readFile(join(m.directory, 'work/ordinary-count'), 'utf8')).toBe('1')
    expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('11')
    await record('display-independent-real-native', { kind, previous, current, restored, instance, ordinaryEffects: 1, displayEffects: 2 })
  })
  it('joins actual CLI visible readers in one finite evaluation and starts only a later visible cycle', async () => {
    const m = await nativeMain(), id = 'visible-readers', input = join(m.directory, 'fields.json')
    await writeFile(input, JSON.stringify({ name: 'Visible readers', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: join(m.directory, 'work'),
      script: "console.log('ordinary')", args: [], display: { script: "import {appendFile,access} from 'node:fs/promises'; await appendFile('display-count','1'); while(true){try{await access('release');break}catch{await new Promise(r=>setTimeout(r,20))}} process.stdout.write('display_visible')", args: [] } }))
    await oneCli('toolkit', 'create', id, '--input', input)
    const one = cli('toolkit', 'watch', id, '--evaluate'), two = cli('toolkit', 'watch', id, '--evaluate')
    await until(async () => expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('1'))
    const running = await inspect(id), runId = running.display!.admission!.run!.runId
    expect((await m.core.listRuns()).map(run => run.runId)).toEqual([runId])
    await writeFile(join(m.directory, 'work/release'), '')
    await until(() => { for (const reader of [one, two]) expect(reader.frames().some(frame => frame.params?.event?.data?.display?.state === 'succeeded')).toBe(true) })
    one.child.kill('SIGTERM'); await until(() => expect(one.code).not.toBeUndefined())
    const three = cli('toolkit', 'watch', id, '--evaluate')
    await until(() => expect(three.frames().length).toBeGreaterThan(0))
    expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('1')
    for (const reader of [two, three]) reader.child.kill('SIGTERM')
    await until(async () => expect((await inspect(id)).consumerCount).toBe(0))
    const next = cli('toolkit', 'watch', id, '--evaluate')
    await until(async () => expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('11'))
    next.child.kill('SIGTERM'); await until(async () => expect((await inspect(id)).consumerCount).toBe(0))
    expect(await m.core.listRuns()).toEqual([])
    await record('display-visible-readers', { sharedRunId: runId, firstCycleEffects: 1, secondCycleEffects: 1, hiddenConsumers: 0 })
  })
  it.each(['inline', 'package'] as const)('continues a lost %s display create reply after real owner restart on the same retained Native Run', async kind => {
    const m = await nativeMain(), id = 'display-resume'
    const packagePath = join(m.directory, 'package')
    if (kind === 'inline') await m.rpc.call('toolkit.create', { toolId: id, value: { name: 'Resume display', icon: 'terminal', enabled: true, statusBar: 'icon',
      workspacePath: join(m.directory, 'work'), script: "console.log('ordinary')", args: [], display: { script: displayScript, args: ['resume'] } } })
    else {
      await mkdir(packagePath)
      await writeFile(join(packagePath, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Resume display', icon: 'terminal', entry: 'ordinary.mjs', display: { entry: 'display.mjs', args: ['resume'] } }))
      await writeFile(join(packagePath, 'ordinary.mjs'), "console.log('ordinary')")
      await writeFile(join(packagePath, 'display.mjs'), displayScript)
      await oneCli('toolkit', 'install', id, '--path', packagePath, '--cwd', join(m.directory, 'work'))
    }
    const originalPort = m.runtime.toolkitRunPort.bind(m.runtime); let runId = ''
    vi.spyOn(m.runtime, 'toolkitRunPort').mockImplementation(async () => {
      const port = await originalPort()
      return { ...port, create: async (input, listener) => { const run = await port.create(input, listener); runId = run.runId; throw new Error('lost-display-reply') } }
    })
    await oneCli('toolkit', 'evaluate', id)
    const unknown = await inspect(id), admission = unknown.display!.admission!
    expect(admission.run).toBeNull(); expect(unknown.display!.state).toBe('unknown')
    await until(async () => expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('1'))
    if (kind === 'package') await rename(packagePath, packagePath + '-unavailable')
    const instance = await m.sdk.daemonInstance(); await m.restart()
    expect(await m.sdk.daemonInstance()).toBe(instance)
    expect((await inspect(id)).display!.admission!.executionId).toBe(admission.executionId)
    await oneCli('toolkit', 'evaluate', id)
    let finished!: ToolkitScriptSnapshot
    await until(async () => { finished = await inspect(id); expect(finished.display!.state).toBe('succeeded'); expect(finished.display!.admission).toBeNull() })
    expect(finished.display!.latestConfirmed).toMatchObject({ executionId: admission.executionId, invocationId: admission.invocationId, run: { runId }, text: 'current_resume' })
    expect(await readFile(join(m.directory, 'work/display-count'), 'utf8')).toBe('1')
    expect(await m.core.listRuns()).toEqual([])
    await record('display-create-recovery', { kind, instance, runId, unknown, finished, effects: 1, editablePackageUnavailable: kind === 'package' })
  })
})
