import { expect, it } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeMain, oneCli, until, record } from './helpers/toolkit-autostart-main-fixture.js'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'

it('compiled CLI and real Main load default scripts and opted-in packages once, preserving manual tools', async () => {
  const m = await nativeMain()
  const marker = join(m.directory, 'automatic-executions')
  const script = `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'x');console.log('startup executed')`
  const fields = { name: 'Startup report', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: m.directory, script, args: [] }
  const input = join(m.directory, 'tool.json')
  await writeFile(input, JSON.stringify(fields))
  await oneCli('toolkit', 'create', 'startup-report', '--input', input)
  const inspect = async (id: string) => (await oneCli('toolkit', 'inspect', id)).result.snapshot as ToolkitScriptSnapshot
  await until(async () => expect((await inspect('startup-report')).state).toBe('succeeded'))
  expect(await readFile(marker, 'utf8')).toBe('x')
  const list = (await oneCli('toolkit', 'ls')).result.tools
  expect(list.find((value: any) => value.toolId === 'startup-report')).toMatchObject({ autoStart: true })
  const first = (await inspect('startup-report')).latestConfirmed!

  const update = join(m.directory, 'update.json')
  await writeFile(update, JSON.stringify({ changes: { name: 'Updated report' }, expected: { name: fields.name } }))
  await oneCli('toolkit', 'update', 'startup-report', '--input', update)
  expect((await inspect('startup-report')).latestConfirmed!.executionId).toBe(first.executionId)
  expect(await readFile(marker, 'utf8')).toBe('x')

  await writeFile(input, JSON.stringify({ ...fields, autoStart: false }))
  await oneCli('toolkit', 'create', 'manual-report', '--input', input)
  expect(await inspect('manual-report')).toMatchObject({ state: 'idle', definition: { autoStart: false } })
  expect(await readFile(marker, 'utf8')).toBe('x')
  await oneCli('toolkit', 'run', 'manual-report')
  await until(async () => expect((await inspect('manual-report')).state).toBe('succeeded'))
  expect(await readFile(marker, 'utf8')).toBe('xx')

  const directory = join(m.directory, 'local-extension')
  await mkdir(directory)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Startup extension', icon: 'terminal', entry: 'report.mjs' }))
  await writeFile(join(directory, 'report.mjs'), script)
  await writeFile(input, JSON.stringify({ kind: 'package', packagePath: directory, workspacePath: m.directory, args: [], enabled: true, statusBar: 'icon', autoStart: false }))
  await oneCli('toolkit', 'create', 'startup-extension', '--input', input)
  expect(await inspect('startup-extension')).toMatchObject({ state: 'idle', definition: { autoStart: false } })
  await writeFile(update, JSON.stringify({ changes: { autoStart: true }, expected: { autoStart: false } }))
  await oneCli('toolkit', 'update', 'startup-extension', '--input', update)
  await until(async () => expect((await inspect('startup-extension')).state).toBe('succeeded'))
  expect(await readFile(marker, 'utf8')).toBe('xxx')
  const packageFirst = (await inspect('startup-extension')).latestConfirmed!
  expect(packageFirst.definition).toMatchObject({ autoStart: true, package: { path: directory } })

  // Reopen actual durable stores through the production Main registration.
  await m.restart()
  await until(async () => {
    expect((await inspect('startup-report')).latestConfirmed!.executionId).not.toBe(first.executionId)
    expect((await inspect('startup-extension')).latestConfirmed!.executionId).not.toBe(packageFirst.executionId)
    expect(await readFile(marker, 'utf8')).toBe('xxxxx')
  })
  expect(await inspect('manual-report')).toMatchObject({ state: 'succeeded', definition: { autoStart: false } })
  const saved = (await m.store.get()).toolkit!.tools!
  expect(saved.find(value => value.id === 'manual-report')).toMatchObject({ autoStart: false })
  expect(saved.find(value => value.id === 'startup-extension')).toMatchObject({ autoStart: true })
  await record('autostart-public-main', { first, packageFirst, saved, executions: await readFile(marker, 'utf8') })
}, 60000)
