import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const entry = new URL('../src/index.ts', import.meta.url)
const signalHandler = "for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {\n  void shutdown().catch(error => { console.error(error); process.exit(1) })\n})\n"

async function runEntry(mode: 'rpc' | 'signal', mutation?: 'signal') {
  const root = await mkdtemp(join(tmpdir(), 'amx-entry-'))
  try {
    let source = await readFile(entry, 'utf8')
    if (mutation === 'signal') {
      expect(source.split(signalHandler)).toHaveLength(2)
      source = source.replace(signalHandler, '').replace('host = await startup', 'host = await startup\n' + signalHandler)
    }
    const original = { AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
      AGENTMUX_STATE_DIRECTORY: join(root, 'state'), CTXMUX_ORIGINAL_CONTEXT: 'original-context' }
    const virtual: Record<string, string> = {
      '@agentmux/core': `
        import { prepareProcessEnvironmentFromLoginShell as prepare } from ${JSON.stringify(fileURLToPath(new URL('../../../packages/core/src/login-shell-environment.ts', import.meta.url)))};
        export const prepareProcessEnvironmentFromLoginShell = () => prepare({ runner: async (_shell, args) => {
          await new Promise(resolve => setTimeout(resolve, 20));
          const marker = args[1].match(/__AGENTMUX_ENV_[\\w-]+__/)[0];
          const values = { PATH: 'provider-search-path', PROVIDER_SETTING: 'shell-provider',
            AGENTMUX_RUNTIME_DIRECTORY: 'shell-runtime', AGENTMUX_STATE_DIRECTORY: 'shell-state',
            AGENTMUX_MESSAGE_QUEUE_PATH: 'shell-queue', AGENTMUX_SPATIAL_STATE_STORE: 'shell-spatial',
            AGENTMUX_AGENT_SESSION_ID: 'shell-agent', AGENTMUX_AGENT_CAPABILITY: 'shell-capability', CTXMUX_SHELL_CONTEXT: 'shell-context' };
          return marker + '\\0' + Object.entries(values).map(([k,v]) => k+'='+v+'\\0').join('') + marker + '\\0';
        } });
        export const loginShellEnvironmentWarning = () => undefined;`,
      './host.js': `
        export const agentMuxHostStore = path => ({ path });
        export async function startAgentMuxHost(options) {
          const observed = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')));
          if (JSON.stringify(Object.entries(observed).sort()) !== JSON.stringify(Object.entries(JSON.parse(process.env.PRIVATE_ENTRY_CONTEXT)).sort()))
            throw Error('The entry replaced original launch context');
          if (process.env.PROVIDER_SETTING !== undefined) throw Error('Host entry waited for shell exports');
          console.log(JSON.stringify({ event: 'available-before-environment' }));
          setTimeout(() => {
            if (process.env.PRIVATE_ENTRY_STOP === 'signal') process.kill(process.pid, 'SIGTERM');
            else void options.shutdown();
          }, 0);
          await options.prepareExecutionEnvironment();
          const prepared = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')));
          if (JSON.stringify(Object.entries(prepared).sort()) !== JSON.stringify(Object.entries(JSON.parse(process.env.PRIVATE_ENTRY_CONTEXT)).sort())) throw Error('The entry replaced original launch context');
          console.log(JSON.stringify({ event: 'context', path: process.env.PATH, provider: process.env.PROVIDER_SETTING }));
          await new Promise(resolve => setTimeout(resolve, 40));
          return { async dispose() { console.log(JSON.stringify({ event: 'disposed' })); },
            hosted: { async call() { return { owner: { processId: process.pid } }; } },
            mobileAccessState: () => ({ state: 'available' }) };
        }`,
      './configured-host-clients.js': `
        export const configuredHostClients = () => ({ clients: () => [], start() {},
          async close() { console.log(JSON.stringify({ event: 'configured-close' })); } });`
    }
    const executable = join(root, 'entry.mjs')
    await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'index.ts', loader: 'ts' },
      outfile: executable, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      plugins: [{ name: 'isolated-entry-owners', setup(context) {
        context.onResolve({ filter: /^(?:@agentmux\/core|\.\/host\.js|\.\/configured-host-clients\.js)$/ }, args => ({ path: args.path, namespace: 'entry-owners' }))
        context.onLoad({ filter: /.*/, namespace: 'entry-owners' }, args => ({ contents: virtual[args.path], loader: 'js', resolveDir: fileURLToPath(new URL('../src', import.meta.url)) }))
      } }] })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    return await exec(process.execPath, [executable], { env: { ...env, ...original, PRIVATE_ENTRY_CONTEXT: JSON.stringify(original), PRIVATE_ENTRY_STOP: mode }, timeout: 3000 })
      .then(value => ({ ...value, code: 0 as number | string, signal: null as string | null, killed: false }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: error.code as number | string, signal: error.signal as string | null, killed: Boolean(error.killed) }))
  } finally { await rm(root, { recursive: true, force: true }) }
}

it.each(['rpc', 'signal'] as const)('the production entry preserves launch context and closes the same starting Host once through %s shutdown', async mode => {
  const result = await runEntry(mode)
  expect(result.code, result.stderr).toBe(0)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(events.filter(value => value.event === 'available-before-environment')).toHaveLength(1)
  expect(events.filter(value => value.event === 'context')).toEqual([{ event: 'context', path: 'provider-search-path', provider: 'shell-provider' }])
  expect(events.filter(value => value.event === 'disposed')).toHaveLength(1)
  expect(events.filter(value => value.event === 'configured-close')).toHaveLength(1)
})

it('the entry assertions reject unhandled startup signals', async () => {
  const signal = await runEntry('signal', 'signal')
  expect(signal.signal).toBe('SIGTERM')
  expect(signal.killed).toBe(false)
  expect(signal.stdout).not.toContain('disposed')
})
