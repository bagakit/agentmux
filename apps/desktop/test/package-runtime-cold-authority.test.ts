import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const helper = process.env.AGENTMUX_COLD_INSTALLER_PATH ?? resolve(import.meta.dirname, '../scripts/package-runtime-upgrade.mjs')
const installer = await import(pathToFileURL(helper).href)
const roots: string[] = []
const servers: Server[] = []
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp('/tmp/amx-cold-pre-'); roots.push(root)
  const socket = join(root, 'socket')
  const oldState = join(root, 'old-state'), nextState = join(root, 'new-state')
  const sentinels = [join(oldState, 'sqlite-original'), join(nextState, 'state-candidate'),
    join(root, 'session-native-handle.json'), join(root, 'workface-layout-draft.json')]
  await mkdir(oldState); await mkdir(nextState)
  for (const [index, path] of sentinels.entries()) await writeFile(path, `NONEMPTY-PRIVATE-SENTINEL-${index}\n`)
  const before = await Promise.all(sentinels.map(async path => sha(await readFile(path))))
  const current = join(root, 'old.app'), candidate = join(root, 'new.app')
  for (const [app, state] of [[current, oldState], [candidate, nextState]]) {
    const core = join(app!, 'Contents/Resources/app/node_modules/@agentmux/core')
    const vendor = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
    await mkdir(join(core, 'dist'), { recursive: true }); await mkdir(join(vendor, 'bin'), { recursive: true })
    await writeFile(join(core, 'package.json'), '{"type":"module"}')
    await writeFile(join(core, 'dist/runtime-paths.js'),
      `export const defaultCtxmuxSocketPath=()=>${JSON.stringify(socket)};export const defaultCtxmuxStateDirectory=()=>${JSON.stringify(state)};`)
    // Only public preflight artifact validation is exercised. These bytes must
    // never be executed/unpacked: the owned socket state ends the chosen branch.
    const binary = Buffer.from('private never-spawned daemon'), archive = Buffer.from('private never-unpacked sdk')
    await writeFile(join(vendor, 'bin/ctxmuxd'), binary); await writeFile(join(vendor, 'sdk.tgz'), archive)
    await writeFile(join(vendor, 'manifest.json'), JSON.stringify({ schema: 'ctxmux.local-artifacts.v1',
      support: { platform: process.platform, architecture: process.arch },
      binaries: [{ name: 'ctxmuxd', path: 'bin/ctxmuxd', sha256: sha(binary) }],
      sdk: { archive: { path: 'sdk.tgz', sha256: sha(archive) } } }))
  }
  return { root, socket, current, candidate, sentinels, before,
    async unchanged() { expect(await Promise.all(sentinels.map(async path => sha(await readFile(path))))).toEqual(before) } }
}
async function listen(path: string) {
  const server = createServer(connection => connection.destroy()); servers.push(server)
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(path, done) })
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('allows explicit dead full preflight despite different state defaults, including its second read', async () => {
  const f = await fixture()
  expect(await installer.prepareRuntimeUpgrade(f.current, f.candidate)).toBeNull()
  expect(await installer.prepareRuntimeUpgrade(f.current, f.candidate)).toBeNull()
  await f.unchanged()
})
it('rejects a real alive listener with different state authority without touching it', async () => {
  const f = await fixture(); await listen(f.socket)
  await expect(installer.prepareRuntimeUpgrade(f.current, f.candidate)).rejects.toThrow('durable host address')
  expect(servers[0]!.listening).toBe(true)
  await f.unchanged()
})
it('keeps ENOTSOCK unknown separate from dead despite different state defaults', async () => {
  const f = await fixture(); await writeFile(f.socket, 'ordinary-file-unknown')
  await expect(installer.prepareRuntimeUpgrade(f.current, f.candidate)).rejects.toThrow('liveness is unknown')
  expect(await readFile(f.socket, 'utf8')).toBe('ordinary-file-unknown')
  await f.unchanged()
})
it('a listener appearing after the first cold read is rejected on the real second preflight', async () => {
  const f = await fixture()
  expect(await installer.prepareRuntimeUpgrade(f.current, f.candidate)).toBeNull()
  await listen(f.socket)
  await expect(installer.prepareRuntimeUpgrade(f.current, f.candidate)).rejects.toThrow('durable host address')
  expect(servers[0]!.listening).toBe(true)
  await f.unchanged()
})
it('keeps UI-only state-address strictness unchanged even when the listener is dead', async () => {
  const f = await fixture()
  await expect(installer.prepareUiRuntime(f.current, f.candidate, null)).rejects.toThrow('durable Runtime address')
  await f.unchanged()
})
