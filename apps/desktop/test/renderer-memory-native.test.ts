import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, readdir } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { build, compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'

it('reads real retained backing through the actual CLI, service and native owner without changing the page', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const directory = await mkdtemp(join(process.env.RENDERER_MEMORY_NATIVE_OUTPUT ?? tmpdir(), 'memory-native-'))
  const namespace = await mkdtemp(join(tmpdir(), 'amux-memory-')), socket = join(namespace, 'c.sock')
  const frozen = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const loaded: Record<string, string> = {}
  const entry = join(directory, 'native.mjs')
  await build({ entryPoints: [join(root, 'apps/desktop/test/renderer-memory-native.fixture.ts')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
    alias: { '@agentmux/core/control': join(root, 'packages/core/src/control.ts'), '@agentmux/core': join(root, 'packages/core/src/index.ts') },
    plugins: [{ name: 'native-memory-current-source', setup(builder) { builder.onLoad({ filter: /\.[cm]?ts$/ }, async args => {
      const path = relative(root, args.path), contents = frozen[path] ?? await readFile(args.path, 'utf8')
      loaded[path] = createHash('sha256').update(contents).digest('hex')
      return { contents, loader: 'ts' }
    }) } }] })
  const modules = join(directory, 'node_modules'), coreModules = join(root, 'packages/core/node_modules')
  await mkdir(modules)
  for (const dependency of await readdir(coreModules)) {
    if (dependency.startsWith('.')) continue
    if (dependency.startsWith('@')) {
      await mkdir(join(modules, dependency))
      for (const name of await readdir(join(coreModules, dependency)))
        await symlink(join(coreModules, dependency, name), join(modules, dependency, name), 'dir')
    } else await symlink(join(coreModules, dependency), join(modules, dependency), 'dir')
  }
  await symlink(join(root, 'packages/core'), join(modules, '@agentmux/core'), 'dir')
  const cliDirectory = join(directory, 'cli'); await mkdir(cliDirectory)
  const cliEntry = await compileRendererProfileCli(root, cliDirectory, frozen)
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|CODEX_|ELECTRON_|NODE_OPTIONS$)/u.test(key)))
  for (const [key, name] of Object.entries({ HOME: 'home', CODEX_HOME: 'codex', AGENTMUX_RUNTIME_DIRECTORY: 'runtime',
    AGENTMUX_STATE_DIRECTORY: 'state', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', TMPDIR: 'tmp' })) {
    env[key] = join(namespace, name); await mkdir(env[key]!, { recursive: true })
  }
  Object.assign(env, { RENDERER_MEMORY_NATIVE_DIRECTORY: directory, RENDERER_MEMORY_NATIVE_SOCKET: socket })
  await writeFile(join(directory, 'child-environment.json'), JSON.stringify({ privatePaths: Object.fromEntries(Object.entries(env).filter(([key]) => /^(HOME|CODEX_HOME|AGENTMUX_RUNTIME_DIRECTORY|AGENTMUX_STATE_DIRECTORY|XDG_.*|TMPDIR)$/u.test(key))),
    inheritedAgentCredential: 'AGENTMUX_AGENT_CAPABILITY' in env, inheritedAgentIdentity: 'AGENTMUX_AGENT_SESSION_ID' in env }))
  const electron = readFileSync(join(root, 'apps/desktop/node_modules/electron/path.txt'), 'utf8').trim()
  const native = spawn(join(root, 'apps/desktop/node_modules/electron/dist', electron), [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  native.stdout.on('data', chunk => { stdout += chunk.toString() }); native.stderr.on('data', chunk => { stderr += chunk.toString() })
  let exited = false
  const exit = new Promise<number | null>(resolve => native.once('close', code => { exited = true; resolve(code) }))
  const until = async (text: string) => {
    const deadline = Date.now() + 10000
    while (!stdout.split('\n').includes(text)) {
      if (exited || Date.now() >= deadline) throw new Error('Private native stage did not complete: ' + text + '\n' + stderr)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const cli = async (target: Record<string, number>, label: string) => {
    const args = Object.entries(target).flatMap(([key, value]) => ['--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(value)])
    const child = spawn(process.execPath, [cliEntry, '--endpoint', 'unix://' + socket, 'system', 'metrics', 'memory', 'inspect', ...args], { env })
    let out = '', err = ''; child.stdout.on('data', data => { out += data.toString() }); child.stderr.on('data', data => { err += data.toString() })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) }).finally(() => clearTimeout(watchdog))
    await writeFile(join(directory, label + '-cli.json'), JSON.stringify({ code, stdout: out, stderr: err }))
    expect(code, err + out).toBe(0)
    const body = JSON.parse(out)
    expect(body).toMatchObject({ ok: true, operation: 'system.metrics.memory.inspect', result: { observation: {
      status: 'completed', target, units: 'bytes', sourceVerified: { before: true, after: true }, cleanup: { detached: 'confirmed' }, issues: [] } } })
    return body.result.observation
  }
  try {
    await until('ready')
    const { target } = JSON.parse(await readFile(join(directory, 'native-ready.json'), 'utf8'))
    const before = await cli(target, 'before')
    native.stdin.write('allocate\n'); await until('allocated')
    const after = await cli(target, 'after')
    expect(before.usage.backingStorageSize).toBeTypeOf('number')
    expect(after.usage.backingStorageSize - before.usage.backingStorageSize).toBeGreaterThanOrEqual(32 * 1024 * 1024)
    native.stdin.write('quit\n')
    expect(await exit).toBe(0)
    expect(JSON.parse(await readFile(join(directory, 'native-debugger-commands.json'), 'utf8'))).toEqual(['Runtime.getHeapUsage', 'Runtime.getHeapUsage'])
    expect(JSON.parse(await readFile(join(directory, 'native-final.json'), 'utf8'))).toMatchObject({ target, attached: false, visible: false,
      ownsBacking: true, title: 'Memory counter positive control' })
    await writeFile(join(directory, 'source-read.json'), JSON.stringify(loaded, null, 2))
  } finally {
    if (!exited) { native.stdin.write('quit\n'); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1000))]); if (!exited) native.kill('SIGKILL') }
    await writeFile(join(directory, 'process-output.json'), JSON.stringify({ stdout, stderr, exited }))
    if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ kind: 'native-memory-fixture', directory, loaded }) + '\n')
    await rm(namespace, { recursive: true, force: true })
    if (!process.env.RENDERER_MEMORY_NATIVE_OUTPUT) await rm(directory, { recursive: true, force: true })
  }
}, 30000)
