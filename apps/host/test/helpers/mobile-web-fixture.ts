import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { headlessFixture, until } from '../../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client.js'
import { generateKeyPair } from '@agentmux/relay/e2ee'

export const mobileHash = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
export async function mobileRelease(directory: string, buildId: string, source = 'export const build = ' + JSON.stringify(buildId)) {
  await mkdir(join(directory, 'assets'), { recursive: true })
  const html = '<!doctype html><title>' + buildId + '</title><script type="module" src="./assets/app.js"></script>'
  await writeFile(join(directory, 'index.html'), html); await writeFile(join(directory, 'assets/app.js'), source)
  const body = { schema: 'agentmux.mobile-web-release.v1', buildId, files: [
    { path: 'assets/app.js', bytes: Buffer.byteLength(source), digest: mobileHash(source) },
    { path: 'index.html', bytes: Buffer.byteLength(html), digest: mobileHash(html) }] }
  const manifest = { ...body, digest: mobileHash(JSON.stringify(body)) }
  await writeFile(join(directory, 'mobile-release.json'), JSON.stringify(manifest))
  return manifest
}
async function ready(child: ChildProcess) {
  return await new Promise<any>((accept, reject) => {
    let output = '', errors = ''
    const timeout = setTimeout(() => reject(Error('Private Main readiness timed out: ' + errors)), 25_000)
    child.stdout!.on('data', value => { output += String(value); const line = output.indexOf('\n'); if (line < 0) return
      clearTimeout(timeout); try { accept(JSON.parse(output.slice(0, line))) } catch (error) { reject(error) } })
    child.stderr!.on('data', value => { errors += String(value) })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(Error('Private Main exited ' + code + ': ' + errors)) })
  })
}
export async function mobileWebFixture(options: { nativeRecord?: boolean } = {}) {
  const ownerKey = 'AGENTMUX_TEST_OWNER_ENTRY', previous = process.env[ownerKey]
  process.env[ownerKey] = resolve(import.meta.dirname, '../fixtures/mobile-web-host.mjs')
  const loader = resolve(import.meta.dirname, '../mobile-web-node-loader.mjs')
  let native: Awaited<ReturnType<typeof headlessFixture>>
  try { native = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env[ownerKey]; else process.env[ownerKey] = previous }
  const info = JSON.parse(await readFile(join(native.env.AGENTMUX_STATE_DIRECTORY!, 'mobile-test-owner.json'), 'utf8'))
  let main: ChildProcess | undefined
  const clients: Array<{ dispose(): Promise<void> }> = []
  const startMain = async () => {
    if (main) throw Error('This private Main already exists')
    main = spawn(process.execPath, ['--experimental-transform-types', '--import', loader, resolve(import.meta.dirname, '../fixtures/mobile-web-main.mjs')],
      { env: native.env, stdio: ['ignore', 'pipe', 'pipe'] })
    return await ready(main)
  }
  const stopMain = async () => {
    if (!main || main.exitCode !== null || main.signalCode !== null) return
    const stopped = once(main, 'exit'); main.kill('SIGTERM'); await stopped; main = undefined
  }
  const relay = async () => {
    const info = JSON.parse(await readFile(join(native.env.AGENTMUX_STATE_DIRECTORY!, 'mobile-test-owner.json'), 'utf8'))
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: info.offer }, relayKeyPair: generateKeyPair() })
    clients.push(client); await client.call('runtime.owner.identity', {}); return client
  }
  try {
    const client = await native.client()
    const capture = join(native.root, 'actual-managed-env.json'), command = join(native.root, 'managed.mjs')
    const original = resolve(import.meta.dirname, '../../../../packages/core/test/fixtures/fake-codex-cli.mjs')
    await writeFile(command, '#!' + process.execPath + '\n' +
      'import {writeFileSync} from "node:fs"; if (!process.argv.includes("--version")) writeFileSync(' + JSON.stringify(capture) + ',JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("AGENTMUX_")))),{mode:0o600}); await import(' + JSON.stringify(original) + ');\n', { mode: 0o700 })
    const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: native.root,
      injectAgentMuxGuide: false, createOperationId: 'mobile-web-private-author', commandOverride: command,
      env: { AGENTMUX_FAKE_READY_MODE: 'before', ...(options.nativeRecord ? { AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original mobile conversation context' } : {}) } })
    const managedEnv = await until(async () => JSON.parse(await readFile(capture, 'utf8').catch(() => '{}')), value => Boolean(value.AGENTMUX_AGENT_CAPABILITY), 'actual managed CLI environment')
    return { native, info, session, managedEnv, client, startMain, stopMain, relay,
      async close() { for (const client of clients) await client.dispose(); await stopMain()
        try { const current = await native.client(); await current.stopAgent(session.agentSessionId, session.run) } finally { await native.cleanup() } } }
  } catch (error) { for (const client of clients) await client.dispose(); await stopMain(); await native.cleanup(); throw error }
}
