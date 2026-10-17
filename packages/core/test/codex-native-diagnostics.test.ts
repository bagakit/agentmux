import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { nativeDiagnosticSource } from './helpers/native-diagnostic-source.js'
import { codexFrontendSocketPath } from '../src/providers/codex-managed-frontend.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private native diagnostic cleanup failed')
})

it.runIf(process.platform === 'darwin').each(['rpc-rejection', 'transport-close'] as const)(
  'retains original native %s diagnostics in the managed child stderr without starting another TUI', async failure => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-diagnostic-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const token = 'private-actor-token-' + failure, capability = 'private-agent-capability-' + failure
    const entry = join(root, 'managed-entry.mjs'), witness = join(root, 'witness.jsonl')
    await build({ entryPoints: [resolve(import.meta.dirname, '../src/providers/codex-managed-run.ts')], outfile: entry,
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      plugins: [{ name: 'actual-native-diagnostic-source', setup(b) { b.onLoad({ filter: /\.ts$/ }, async ({ path }) =>
        ({ contents: nativeDiagnosticSource(await readFile(path, 'utf8'), path), loader: 'ts' })) } }]
    })
    const plan = { command: resolve(import.meta.dirname, 'fixtures/native-diagnostic-cli.mjs'), serverConfig: [], frontendArgs: [],
      args: ['resume', '00000000-0000-4000-8000-0000000000dc'], resume: { threadId: '00000000-0000-4000-8000-0000000000dc' } }
    const child = spawn(process.execPath, [entry, JSON.stringify(plan)], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, CODEX_HOME: join(root, 'codex'), AGENTMUX_CODEX_ACTOR_TOKEN: token, AGENTMUX_AGENT_CAPABILITY: capability,
      AGENTMUX_CODEX_ACTOR_ID: 'private-original-actor', AGENTMUX_CODEX_ACTOR_LIFECYCLE: 'private-original-launch',
      AGENTMUX_DIAGNOSTIC_WITNESS: witness, AGENTMUX_DIAGNOSTIC_FAILURE: failure
    } })
    cleanup.push(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, 'SIGKILL'); await once(child, 'close') }
      } finally { await rm(codexFrontendSocketPath(token), { force: true }) }
    })
    const chunks: Buffer[] = []; child.stdout.resume(); child.stderr.on('data', chunk => chunks.push(Buffer.from(chunk)))
    const [code, signal] = await once(child, 'close'), stderr = Buffer.concat(chunks).toString('utf8')
    const records = (await readFile(witness, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const original = records.find(row => row.kind === 'diagnostic').diagnostic as string
    const expected = original.replaceAll(token, '[redacted]').replaceAll(capability, '[redacted]')
    expect(code).toBe(1); expect(signal).toBeNull()
    expect(stderr).toContain(expected)
    expect(stderr).not.toContain(token); expect(stderr).not.toContain(capability)
    expect(stderr).toContain('The original native resume request could not be confirmed before TUI start.')
    expect(stderr).toContain(failure === 'rpc-rejection' ? '[code=-32602]: Exact original native configuration rejected; actor=[redacted]' : 'Original native actor transport closed.')
    expect(records.filter(row => row.kind === 'backend')).toHaveLength(1)
    expect(records.filter(row => row.kind === 'frontend')).toHaveLength(0)
    expect(records.filter(row => row.kind === 'rpc').map(row => row.method)).toEqual(['initialize', 'thread/resume'])
  }, 30_000)
