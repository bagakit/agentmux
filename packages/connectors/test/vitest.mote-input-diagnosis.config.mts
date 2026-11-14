import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.mote-chat.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.MOTE_INPUT_DIAGNOSIS_MUTANT
const changes: Record<string, { path: string; from: string; to: string }> = {
  'drop-initial-failure': { path: 'packages/core/src/mote/chat-diagnosis.ts', from: ", 'AGENT_INITIAL_INPUT_UNCONFIRMED'", to: '' },
  'drop-wait-observation': { path: 'packages/connectors/src/mote-chat-diagnosis.ts',
    from: 'waitObservation: receipt ? moteChatInputWaitObservation(receipt) : null,', to: 'waitObservation: null,' },
  'borrow-retired-run': { path: 'packages/connectors/src/durable-ingress.ts',
    from: 'sessionSemanticResumeSourceRuns(session).includes(input.expectedRun.runId)',
    to: '(session.retiredRuns.some(run => run.runId === input.expectedRun.runId) || session.run.runId === input.expectedRun.runId)' }
}
const change = mutation ? changes[mutation] : undefined
if (mutation && !change) throw Error('Unknown original input diagnosis mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.local/mote-input-diagnosis/cache', mutation ?? 'original'),
  plugins: [{ name: 'mote-input-original-source', enforce: 'pre', resolveId(source, importer) {
    if (source.startsWith('@agentmux/')) {
      const [name, ...parts] = source.slice('@agentmux/'.length).split('/')
      const directory = resolve(root, name === 'host' ? 'apps/host' : 'packages/' + name)
      const manifestPath = resolve(directory, 'package.json')
      if (!existsSync(manifestPath)) return
      const entry = JSON.parse(readFileSync(manifestPath, 'utf8')).exports[parts.length ? './' + parts.join('/') : '.']?.import
      if (name === 'identity' && parts[0] === 'runtime-source') return resolve(directory, 'dist/runtime-source.js')
      if (name === 'identity' && parts[0] === 'runtime') return resolve(directory, 'src/runtime-entry.ts')
      if (entry?.startsWith('./dist/')) return resolve(directory, 'src', entry.slice(7).replace(/^src\//u, '').replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const path = resolve(dirname(importer), source)
    const match = path.match(/\/(?:packages\/(core|connectors|identity)|apps\/(host))\/dist\/(.+)\.js$/u)
    if (match) {
      const directory = resolve(root, match[2] ? 'apps/host' : 'packages/' + match[1])
      const source = resolve(directory, 'src', match[3]! + '.ts')
      if (existsSync(source)) return source
      if (match[1] === 'identity' && match[3] === 'runtime-source') return resolve(directory, 'dist/runtime-source.js')
    }
  }, transform(original, id) {
    const path = id.split('?')[0]!, served = relative(root, path)
    if (/\/(?:packages\/(?:core|connectors|identity)|apps\/host)\/src\//u.test(path) && (served.startsWith('../') || served.startsWith('/')))
      throw Error('The diagnosis consumer escaped its assigned workspace Source')
    if (!/^(?:packages\/(?:core|connectors|identity)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(served)) return
    let loaded = original
    if (change?.path === served) {
      if (original.split(change.from).length !== 2) throw Error('Missing or ambiguous original diagnosis mutation anchor')
      loaded = original.replace(change.from, change.to)
    }
    const trace = process.env.MOTE_INPUT_DIAGNOSIS_LOADED
    if (!trace) return loaded === original ? undefined : { code: loaded, map: null }
    if (served === 'packages/core/test/helpers/object-cli-rpc.ts') {
      const spawn = "const child = spawn(executable, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })"
      const close = 'resolve({ code, stdout, stderr })'
      if (loaded.split(spawn).length !== 2 || loaded.split(close).length !== 2) throw Error('Original compiled CLI observation seam changed')
      loaded = loaded.replace(spawn, spawn + `; __moteInputTrace(${JSON.stringify(trace)}, JSON.stringify({ kind: 'compiled-cli-start', pid: child.pid, ownerPid: process.pid, executable, cli, compiled }) + ${JSON.stringify('\n')})`)
        .replace(close, `__moteInputTrace(${JSON.stringify(trace)}, JSON.stringify({ kind: 'compiled-cli-exit', pid: child.pid, code }) + ${JSON.stringify('\n')}); ` + close)
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const facts = JSON.stringify({ path: served, loaderPid: process.pid, sourceSHA256: sha(original), loadedSHA256: sha(loaded), mutation: change?.path === served ? mutation : null,
      observationOnly: served === 'packages/core/test/helpers/object-cli-rpc.ts' })
    return { code: `import { appendFileSync as __moteInputTrace } from 'node:fs'; __moteInputTrace(${JSON.stringify(trace)}, JSON.stringify({ ...${facts}, consumerPid: process.pid }) + ${JSON.stringify('\n')});\n` + loaded, map: null }
  } }, ...original.plugins!], test: { ...original.test, include: [
    'packages/core/test/mote-chat-diagnosis.test.ts',
    'packages/connectors/test/mote-chat-waiting.integration.test.ts',
    'packages/connectors/test/mote-chat-diagnosis.integration.test.ts',
    'packages/connectors/test/mote-input-diagnosis.integration.test.ts'
  ], globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
