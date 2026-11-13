import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { headlessFixture } from './helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private remote home proof cleanup failed.')
})

it.each(['ssh', 'tailcat'] as const)('actual CLI over the %s stdio carrier reads the target Core OS home without adopting the CLI user home', async transport => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  const calls = join(scope.root, 'home-carriers')
  await writeFile(calls, '')
  const forward = pathToFileURL(resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  // Only the official CLI stdio boundary is controlled. The independently
  // running target Core/Native and public CLI are real. No SSH authentication,
  // WireGuard traffic or target-Mac reachability is claimed by this test.
  await writeFile(join(scope.root, transport), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { forwardAgentMuxRpcStdio } from ${JSON.stringify(forward)};
appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(transport + '\n')});
await forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(scope.socketPath)}},input:process.stdin,output:process.stdout});
`, { mode: 0o700 })
  const endpoint = transport === 'ssh' ? 'ssh://literal-user@literal-home-target.fixture'
    : 'tailcat:tcSynthetic_HomeCredential-A?key=saved-home-client'
  const cliHome = join(scope.root, 'different-cli-user-home')
  const result = await runCompiledObjectCli(['--endpoint', endpoint, 'settings', 'hosts', 'home', '--host', 'local'],
    objectCliEnvironment(scope.root, { PATH: `${scope.root}:${process.env.PATH}`, HOME: cliHome }))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toEqual({ routeHostId: 'local', homeDirectory: join(scope.root, 'home') })
  expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([transport])
}, 30_000)
