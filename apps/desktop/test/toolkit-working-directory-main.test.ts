import { expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'
import { nativeMain, oneCli, cli, until, record } from './toolkit-main.fixture.js'
import { createToolkitConfigurationApi } from '../src/renderer/src/lib/toolkit-configuration-api.js'
import type { AgentMuxPreloadApi } from '../src/shared/contracts.js'

it('uses Host shorthand through actual public CLI and retains an existing TUI cwd across saves', async () => {
  const main = await nativeMain(), oldPath = join(main.directory, '.agentmux'), nextPath = join(main.directory, 'next folder')
  await mkdir(oldPath, { recursive: true }); await mkdir(nextPath, { recursive: true })
  const input = join(main.directory, 'directory-tool.json')
  await writeFile(input, JSON.stringify({ name: 'Directory TUI', icon: 'terminal', enabled: true, statusBar: 'icon',
    mode: 'tui', workspacePath: '~/.agentmux', script: 'printf "CWD:%s\\n" "$PWD"; exec cat', args: [] }))
  const definition = (await oneCli('toolkit', 'create', 'directory-tui', '--input', input)).result.definition
  expect(definition.workspacePath).toBe(oldPath)
  const inspect = async (): Promise<ToolkitScriptSnapshot> => (await oneCli('toolkit', 'inspect', 'directory-tui')).result.snapshot
  await until(async () => expect((await inspect()).admission?.run).toBeTruthy())
  const original = (await inspect()).admission!, run = original.run!
  await until(async () => {
    const replay = await main.core.readRunReplay({ runId: run.runId }, 0, 'raw')
    expect(replay.replay.map(chunk => new TextDecoder().decode(chunk.dataBytes)).join('')).toContain('CWD:' + oldPath)
  })
  await writeFile(input, JSON.stringify({ changes: { workspacePath: '${HOME}/next folder' }, expected: { workspacePath: '$HOME/.agentmux' } }))
  const changed = (await oneCli('toolkit', 'update', 'directory-tui', '--input', input)).result
  expect(changed).toMatchObject({ changed: true, definition: { workspacePath: nextPath } })
  expect(await inspect()).toMatchObject({ definition: { workspacePath: nextPath },
    admission: { executionId: original.executionId, run, definition: { workspacePath: oldPath } } })
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).toBe('running')
  await writeFile(input, JSON.stringify({ changes: { workspacePath: '~/next folder' }, expected: { workspacePath: '${HOME}/next folder' } }))
  expect((await oneCli('toolkit', 'update', 'directory-tui', '--input', input)).result).toMatchObject({ changed: false,
    definition: { revision: changed.definition.revision, workspacePath: nextPath } })
  await writeFile(input, JSON.stringify({ changes: { workspacePath: './ambiguous' } }))
  const rejected = cli('toolkit', 'update', 'directory-tui', '--input', input)
  await until(() => expect(rejected.code).not.toBeUndefined())
  expect(rejected.code).not.toBe(0)
  expect(rejected.stdout + rejected.stderr).toContain('Working directory')
  expect(await inspect()).toMatchObject({ admission: { executionId: original.executionId, run }, definition: { workspacePath: nextPath } })
  const renderer = createToolkitConfigurationApi({ update: async (...args: unknown[]) =>
    structuredClone(await main.invoke('toolkit:update', ...args)) } as unknown as AgentMuxPreloadApi['toolkit'])
  await expect(renderer.update('directory-tui', { workspacePath: './ambiguous' }, { workspacePath: nextPath }))
    .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE', detail: 'toolkit.workspacePath' })
  expect(await renderer.update('directory-tui', { workspacePath: '~/next folder' }, { workspacePath: nextPath }))
    .toMatchObject({ changed: false, definition: { workspacePath: nextPath } })

  const installed = (await oneCli('toolkit', 'install', 'default-directory-package', '--path', join(main.directory, 'package'))).result.definition
  expect(installed.workspacePath).toBe(oldPath)
  const explicit = (await oneCli('toolkit', 'install', 'explicit-directory-package', '--path', join(main.directory, 'another-package'), '--cwd', '$HOME/next folder')).result.definition
  expect(explicit.workspacePath).toBe(nextPath)
  await record('working-directory-public-chain', { definition, changed, run, originalExecution: original.executionId,
    installed, explicit, invalidRejected: true, originalCwdRetained: true })
})

it('returns a native folder selection without registering a workspace or saving configuration', async () => {
  const main = await nativeMain()
  await main.invoke('notesStorage:inspect')
  const before = await main.store.get(), picked = join(main.directory, 'picked folder')
  const { dialog } = await import('electron')
  const choose = vi.mocked(dialog.showOpenDialog)
  choose.mockResolvedValueOnce({ canceled: false, filePaths: [picked] })
  expect(await main.invoke('ui:chooseDirectory', { defaultPath: '~/.agentmux' })).toBe(picked)
  expect(choose).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7 }), {
    properties: ['openDirectory'], defaultPath: join(main.directory, '.agentmux') })
  choose.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  expect(await main.invoke('ui:chooseDirectory')).toBeNull()
  expect(await main.store.get()).toEqual(before)
  await record('working-directory-native-picker', { picked, canceled: true, configurationUnchanged: true })
})
