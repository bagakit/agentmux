import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port }
/** Actual loopback OpenSSH authentication; keys/config never touch the user's SSH directory.
 * These environment-bound tests require AGENTMUX_REAL_SSH_ROUTE_E2E=1 explicitly.
 * Once requested, missing sshd or failed authentication is a real test failure. */
export async function sshRouteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-route-ssh-')), servers: ChildProcess[] = []
  for (const name of ['host', 'client']) await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)])
  await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'client.pub')))
  await writeFile(join(root, 'known_hosts'), '')
  const config = join(root, 'client_config'), log = join(root, 'clients.ndjson')
  await writeFile(config, `Host *\n  UserKnownHostsFile ${join(root, 'known_hosts')}\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  IdentitiesOnly yes\n`)
  await writeFile(join(root, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(log)}\nexec /usr/bin/ssh -F ${quote(config)} "$@"\n`, { mode: 0o700 })
  const command = join(root, 'amux')
  await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dirname, '../../dist/agentmux.js'))} "$@"\n`, { mode: 0o700 })
  const publicKey = (await readFile(join(root, 'host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ')
  async function route() {
    const port = await freePort(), path = join(root, `server-${port}`)
    await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${publicKey}\n`, { flag: 'a' })
    await writeFile(path, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${join(root, 'host')}\nPidFile ${path}.pid\nAuthorizedKeysFile ${join(root, 'authorized_keys')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nLogLevel ERROR\n`)
    const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path], { stdio: ['ignore', 'ignore', 'pipe'] }); servers.push(child)
    let errors = ''; child.stderr!.on('data', bytes => { errors += bytes })
    await execute('/usr/bin/ssh', ['-F', config, '-i', join(root, 'client'), '-p', String(port), '-o', 'ConnectionAttempts=10', '-o', 'ConnectTimeout=1', `${userInfo().username}@127.0.0.1`, 'true']).catch(error => { throw new Error(`${error.message}; private sshd: ${errors}`) })
    return { hostname: '127.0.0.1', user: userInfo().username, port, identityFile: join(root, 'client'), remoteCommand: command,
      stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') } }
  }
  return { root, route, async channelPids() { try { return (await readFile(log, 'utf8')).trim().split('\n').map(Number) } catch { return [] } },
    async cleanup() { for (const server of servers) if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); await rm(root, { recursive: true, force: true }) } }
}
