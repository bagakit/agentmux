import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createExecutionHost } from '../src/main/host-factory.js'
import { headlessFixture } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private Host command cleanup failed.')
})

it.each(['tailcat', 'ssh-tailcat'] as const)('the actual Desktop factory runs file and Git commands through %s, retaining its Host and existing RPC owner', async transport => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const calls = join(scope.root, 'carrier-calls')
  await writeFile(calls, '')
  const forwarding = pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/dist/agentmux-rpc-stdio.js')).href
  // Controlled CLI carrier only; the command, original RPC owner and ctxmux Run are real.
  await writeFile(join(scope.root, 'tailcat'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { forwardAgentMuxRpcStdio } from ${JSON.stringify(forwarding)};
appendFileSync(${JSON.stringify(calls)}, 'tailcat\\n');
await forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(scope.socketPath)}},input:process.stdin,output:process.stdout});
`, { mode: 0o700 })
  await writeFile(join(scope.root, 'ssh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'ssh\\n');
process.exit(255);
`, { mode: 0o700 })
  vi.stubEnv('PATH', `${scope.root}:${process.env.PATH}`)
  const host = createExecutionHost({ id: 'original-remote-host', kind: 'ssh', label: 'Other Mac', hostname: transport === 'tailcat' ? '' : 'literal-test-ssh',
    transport, tailcat: { address: 'tcSynthetic_Credential-A', keyFile: 'saved-test-client' }, runtimeId: scope.owner.runtimeId })
  closes.push(() => host.dispose())
  expect(host.id).toBe('original-remote-host')
  const file = join(scope.root, 'command-file')
  expect(await host.run('/bin/sh', ['-c', 'cat > "$1"', 'test', file], { input: 'original binary-compatible input\n', cwd: scope.root })).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  expect(await host.run('/bin/cat', [file])).toEqual({ stdout: 'original binary-compatible input\n', stderr: '', exitCode: 0 })
  const git = await host.run('git', ['--version'])
  expect(git.exitCode).toBe(0); expect(git.stdout).toMatch(/^git version /u)
  expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(transport === 'tailcat' ? ['tailcat'] : ['ssh', 'tailcat'])
}, 30_000)
