import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../../src/managed-hook-installer.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'

afterEach(() => vi.unstubAllEnvs())
const exec = promisify(execFile)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const profile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'

it.runIf(Boolean(process.env.AGENTMUX_PI_NATIVE_PACKAGE))('native Pi loads the shared extension, keeps its original Core Run and ignores outside hosts', async () => {
  const pkg = process.env.AGENTMUX_PI_NATIVE_PACKAGE!, proofPath = process.env.AGENTMUX_PI_NATIVE_RECEIPT
  const root = await realpath(await mkdtemp('/private/tmp/amx-pi-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace'), agent = join(home, '.pi', 'agent')
  const runtime = join(root, 'runtime'), storePath = join(root, 'sessions.json'), trace = join(root, 'native.jsonl')
  for (const path of [home, workspace, agent, runtime, join(root, 'tmp')]) await mkdir(path, { recursive: true })
  await writeFile(trace, '')
  const env = { PATH: process.env.PATH!, HOME: home, PI_CODING_AGENT_DIR: agent, TMPDIR: join(root, 'tmp'),
    PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1', LANG: 'en_US.UTF-8',
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const cli = join(pkg, 'dist/bundle/cli.js')
  const { stdout: version } = await exec(process.execPath, [cli, '--version'], { env, cwd: workspace })
  let modelCalls = 0, trapCalls = 0
  const backend = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes
    if (request.url === '/foreign') { trapCalls++; response.end('{}'); return }
    modelCalls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'PRIVATE_PI_COMPLETE' }, null], [{}, 'stop']]) response.write('data: ' +
      JSON.stringify({ id: 'pi-native-proof', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(backend.address() as { port: number }).port}`
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { private: { baseUrl: base + '/v1', api: 'openai-completions', apiKey: 'dummy',
    models: [{ id: 'probe', contextWindow: 128000, maxTokens: 100, input: ['text'], reasoning: false }] } } }))
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [], quietStartup: true }))
  const extensionDir = join(agent, 'extensions'); await mkdir(extensionDir)
  // A separate native extension changes ambient env after the managed extension was initialized.
  // It also records actual native session identity independently of Core ingress.
  await writeFile(join(extensionDir, 'z-native-observer.js'), `import{appendFileSync}from'node:fs';export default function(pi){
    pi.on('before_agent_start',()=>{process.env.AGENTMUX_HOOK_URL=${JSON.stringify(base + '/foreign')};process.env.AGENTMUX_HOOK_TOKEN='foreign-token'});
    pi.on('agent_settled',(_e,ctx)=>{appendFileSync(${JSON.stringify(trace)},JSON.stringify({id:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile()})+'\\n')});}`)
  const launcher = join(root, 'pi')
  await writeFile(launcher, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 })
  const provider = new AgentProviderRegistry().get('pi'), store = new AgentMuxFileAgentSessionStore(storePath)
  const client = new AgentMuxClient({ providers: [provider], store, hookInstaller: new AgentManagedHookInstaller(join(root, 'receipts')) })
  const daemon = spawn(fileURLToPath(new URL(`../../vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, import.meta.url)), [
    '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(root, 'daemon'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const closed = once(daemon, 'close'); let session: Awaited<ReturnType<typeof client.createAgent>> | undefined, proof: Record<string, unknown> | undefined
  try {
    await once(daemon.stdio[3]!, 'data'); await client.connect()
    session = await client.createAgent({ agentSessionId: 'private-native-pi', createOperationId: 'create-private-native-pi', providerId: 'pi', executorId: 'native-pi',
      workspacePath: workspace, commandOverride: launcher, env, injectAgentMuxGuide: false, prompt: 'Reply PRIVATE_PI_COMPLETE.',
      args: ['--print', '--mode', 'json', '--model', 'private/probe'] })
    await expect.poll(async () => (await store.readMetadata(session!.agentSessionId))?.hookReceipt?.eventName, { timeout: 15_000 }).toBe('agent_settled')
    const native = JSON.parse((await readFile(trace, 'utf8')).trim())
    const retained = await client.readAgentSession(session.agentSessionId)
    expect(retained?.run).toEqual(session.run)
    expect(retained?.nativeHandle).toMatchObject({ providerId: 'pi', sessionId: native.id, transcriptPath: native.file })
    expect(trapCalls).toBe(0); expect(modelCalls).toBe(1)
    const target = join(extensionDir, 'agentmux.js'), source = await readFile(target, 'utf8')
    const inspected = await client.inspectManagedHooks('pi', { workspacePath: workspace, env })
    expect(inspected.status).toBe('installed'); expect(inspected.targets).toEqual([{ path: target, status: 'current' }])
    // True native loader reads the same generated file under each outside env. Host factory
    // must leave the file loadable while registering no AgentMux event consumer.
    const index = pathToFileURL(join(pkg, 'dist/index.js')).href
    const loader = `const{discoverAndLoadExtensions,getAgentDir}=await import(${JSON.stringify(index)});const r=await discoverAndLoadExtensions([],process.cwd(),getAgentDir());const e=r.extensions.find(x=>x.resolvedPath===${JSON.stringify(target)});console.log(JSON.stringify({errors:r.errors,loaded:!!e,handlers:e?[...e.handlers.keys()]:null,agentDir:getAgentDir()}));`
    for (const providerId of [undefined, 'claude']) {
      const outsideEnv: Record<string, string> = { ...env, AGENTMUX_HOOK_URL: base + '/foreign', AGENTMUX_HOOK_TOKEN: 'foreign-token',
        ...(providerId ? { AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: providerId } : {}) }
      const result = JSON.parse((await exec('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '--input-type=module', '-e', loader],
        { env: outsideEnv, cwd: workspace })).stdout.trim())
      expect(result.errors).toEqual([]); expect(result.loaded).toBe(true); expect(result.handlers).toEqual([])
    }
    const nativeRoots: Record<string, string> = {}
    for (const value of ['', '  ', ' relative-root ', '~', '~/literal-root', pathToFileURL(join(root, 'url-root')).href]) {
      const pathEnv = { ...env, PI_CODING_AGENT_DIR: value }
      const result = await exec(process.execPath, ['--input-type=module', '-e', `const{getAgentDir}=await import(${JSON.stringify(index)});console.log(JSON.stringify(getAgentDir()))`], { env: pathEnv, cwd: workspace })
      const nativeRoot = JSON.parse(result.stdout.trim()); nativeRoots[value] = nativeRoot
      expect(provider.planManagedHooks!({ workspacePath: workspace, env: pathEnv })!.mutations[0]!.path)
        .toBe(resolve(workspace, nativeRoot, 'extensions/agentmux.js'))
    }
    expect(await readFile(target, 'utf8')).toBe(source); expect(trapCalls).toBe(0)
    proof = { version: version.trim(), scope: 'native Pi CLI public Core create and native loader', originalRun: session.run, nativeSessionId: native.id,
      coreReceivedSettled: true, originalBindingKeptAfterEnvChange: true, passiveNativeHosts: 2, foreignIngress: 0, publicInspection: true,
      nativeRoots, noExternalHookNode: !source.includes('child_process'), packageRoot: pkg }
  } finally {
    if (session) await client.stopAgent(session.agentSessionId, session.run).catch(() => {})
    await client.dispose(); daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 2_000)
    try { await closed } finally { clearTimeout(timer) }
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
  if (proofPath) await writeFile(proofPath, JSON.stringify({ ...proof, privateStateRemoved: true }, null, 2) + '\n')
}, 45_000)
