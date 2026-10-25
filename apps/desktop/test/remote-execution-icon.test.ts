import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import type { AgentMuxControlSettingsResourceRequest } from '../../../packages/core/src/control.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('publishes remote execution through the Main/Host theme owner, public RPC and compiled CLI as read-only discovery', async () => {
  const fixture = await configOwnerFixture(), original = await fixture.bytes()
  const directory = await mkdtemp(join(tmpdir(), 'remote-execution-icon-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
    execute: request => executeSettingsResourcesControl(request as AgentMuxControlSettingsResourceRequest, fixture.owner) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  const listing = await rpc.call('settings.themes.ls', {})
  expect(listing.resource).toBe('themes')
  if (listing.resource !== 'themes') throw new Error('Expected the actual themes response')
  const expected = { id: 'object.remote-execution', label: 'Remote execution', groupId: 'object', defaultGlyph: 'execution-split' }
  expect(listing.iconCatalog.icons.find(icon => icon.id === expected.id)).toMatchObject(expected)
  expect(listing.iconCatalog.glyphs).toContain('execution-split')
  const cli = await runCompiledObjectCli(['settings', 'themes', 'ls'], objectCliEnvironment(directory))
  expect(cli.code, cli.stderr).toBe(0)
  const output = JSON.parse(cli.stdout)
  expect(output).toMatchObject({ ok: true, operation: 'settings.themes.ls' })
  expect(output.result.iconCatalog.icons.find((icon: { id: string }) => icon.id === expected.id)).toMatchObject(expected)
  expect(output.result.iconCatalog).toEqual(listing.iconCatalog)
  expect(await fixture.bytes()).toBe(original)
  expect(fixture.save).not.toHaveBeenCalled()
  expect(fixture.publish).not.toHaveBeenCalled()
}, 30_000)
