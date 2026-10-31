import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { ConfigStore } from '../src/main/config-store'

it('discovers five choices, persists through the public service and real CLI, and preserves the prior choice on rejection', async () => {
  const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite' } })
  const directory = await mkdtemp(join(tmpdir(), 'app-icon-cli-'))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: input => {
    if (input.operation !== 'settings.get' && input.operation !== 'settings.set') throw new Error('Unexpected owner')
    return executeSettingsControl(input, f.owner)
  } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const cli = (args: string[]) => runCompiledObjectCli(['settings', ...args], objectCliEnvironment(directory))
  try {
    const bytes = await f.bytes()
    expect(await rpc.call('settings.inspect', { target: 'appearance.appIcon' })).toMatchObject({ entries: [{
      key: 'appearance.appIcon', value: 'qingzhuan', default: 'qingzhuan', enum: ['qingzhuan', 'huihuan', 'zheyu', 'lingban', 'classic']
    }] })
    await rpc.call('settings.set', { key: 'appearance.appIcon', value: 'qingzhuan' })
    expect(await f.bytes()).toBe(bytes)
    expect(f.save).not.toHaveBeenCalled()
    for (const id of ['huihuan', 'zheyu', 'lingban', 'classic', 'qingzhuan']) {
      const saved = await cli(['set', 'appearance.appIcon', id])
      expect(saved.code, saved.stderr || saved.stdout).toBe(0)
      expect(JSON.parse(saved.stdout)).toMatchObject({ ok: true, result: { entry: { value: id } } })
      expect((await new ConfigStore(f.store.filePath).get()).appearance.appIcon).toBe(id)
    }
    const before = await f.bytes()
    const invalid = await cli(['set', 'appearance.appIcon', 'unknown-brand'])
    expect(invalid.code).not.toBe(0)
    expect(await f.bytes()).toBe(before)
    const inspected = await cli(['inspect', 'appearance.appIcon'])
    expect(inspected.code, inspected.stderr || inspected.stdout).toBe(0)
    expect(JSON.parse(inspected.stdout).result.entries[0].value).toBe('qingzhuan')
    await expect(f.store.save({ ...f.owner.current, appearance: { ...f.owner.current.appearance, appIcon: 'invalid' as never } })).rejects.toBeInstanceOf(Error)
    expect(await f.bytes()).toBe(before)
  } finally { rpc.dispose(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 30_000)
