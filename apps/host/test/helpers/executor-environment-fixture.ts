import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../../packages/core/src/hosted-client.js'
import { until } from '../../../../packages/core/test/helpers/headless-runtime-fixture.js'

const repository = resolve(import.meta.dirname, '../../../..'), exec = promisify(execFile)
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended }
}
export async function executorEnvironmentFixture(cleanups: Array<() => Promise<unknown>>, cold = false) {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'aer-')), home = join(root, 'home'), state = join(root, 's'), runtime = join(root, 'r')
  for (const directory of [home, state, runtime, join(state, 'ctxmux'), join(root, 'base-bin'), join(root, 'new tools')]) await mkdir(directory, { mode: 0o700 })
  const socketPath = join(runtime, 'control.sock'), hold = join(root, 'hold-shell'), arms = join(root, 'shell-arms')
  const shell = join(root, 'profile-shell'), command = 'fixture-agent', baseCommand = join(root, 'base-bin', 'fixture-base')
  const executable = '#!/bin/sh\nprintf "READY:%s\\n" "$FIXTURE_EXPORT"\nwhile IFS= read -r input; do printf "INPUT:%s\\n" "$input"; done\n'
  await writeFile(baseCommand, executable, { mode: 0o755 })
  const install = async () => {
    await writeFile(join(root, 'new tools', command), executable, { mode: 0o755 })
    await writeFile(join(home, '.zshrc'), 'export PATH=' + JSON.stringify(join(root, 'new tools') + ':' + join(root, 'base-bin') + ':/usr/bin:/bin') + '\nexport FIXTURE_EXPORT=installed\n')
  }
  await writeFile(join(home, '.zshrc'), 'export PATH=' + JSON.stringify(join(root, 'base-bin') + ':/usr/bin:/bin') + '\nexport FIXTURE_EXPORT=initial\n')
  await writeFile(shell, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + JSON.stringify(arms) + '\nwhile [ -e ' + JSON.stringify(hold) + ' ]; do /bin/sleep 0.02; done\nexec /bin/zsh "$@"\n', { mode: 0o755 })
  if (cold) { await install(); await writeFile(hold, '') }
  const configurationPath = join(root, 'config.json')
  const configuration = { version: 9, hosts: [{ id: 'local', kind: 'local' as const, label: 'Private Host' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'workspace', name: 'Private workspace', kind: 'folder' as const, hostId: 'local', path: root }], appearance: {}, browser: {} }
  await writeFile(configurationPath, JSON.stringify(configuration))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key))),
    HOME: home, ZDOTDIR: home, SHELL: shell, PATH: '/usr/bin:/bin', AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    AGENTMUX_HOST_CONFIGURATION_PATH: configurationPath, AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'no-mobile') }
  let daemon: ChildProcess | undefined, host: ChildProcess | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, client: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  cleanups.push(async () => {
    const errors: unknown[] = []
    for (const close of [() => rm(hold, { force: true }), () => client?.dispose(), () => rpc?.dispose(), () => stop(host), () => stop(daemon)]) try { await close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Private environment owner cleanup failed; retained ' + root)
    await rm(root, { recursive: true, force: true })
  })
  const artifact = resolve(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
  daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let nativeError = ''; daemon.stderr!.on('data', value => { nativeError += value })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw Error('Private Native exited: ' + nativeError) })])
  const loader = resolve(repository, 'apps/host/test/executor-environment-node-loader.mjs')
  host = spawn(process.execPath, ['--experimental-transform-types', '--import', loader, resolve(repository, 'apps/host/src/index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; host.stdout!.on('data', value => { stdout += value }); host.stderr!.on('data', value => { stderr += value })
  await until(async () => ({ stdout, exitCode: host!.exitCode, stderr }), value => {
    if (value.exitCode !== null) throw Error('Private Host exited: ' + value.stderr)
    return value.stdout.includes('\n')
  }, 'original Host publication', 30_000)
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); client = await connectHostedAgentMux({ rpc }); await client.connect()
  const cli = async (refresh: boolean) => {
    const result = await exec(process.execPath, ['--experimental-transform-types', '--import', loader, resolve(repository, 'packages/core/src/agentmux.ts'),
      '--endpoint', 'unix:' + socketPath, 'settings', 'executors', 'discover', '--host', 'local', '--executor', 'codex', '--refresh', String(refresh)], { env, maxBuffer: 1024 * 1024 })
    return JSON.parse(result.stdout).result
  }
  return { root, env, configuration, client, rpc, socketPath, command, baseCommand, install, cli, originalOwner: client.runtimeOwnerIdentity()!,
    arms: async () => (await readFile(arms, 'utf8')).trim().split('\n'), hold: () => writeFile(hold, ''), release: () => rm(hold, { force: true }),
    stderr: () => stderr, hostPid: host.pid, nativePid: daemon.pid }
}
