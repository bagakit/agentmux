import { defineConfig } from 'vitest/config'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './agent-learning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'delegation-participants': ['apps/host/src/goal-delegation-owner.ts', "if (owner.kind !== 'agent' || worker.kind !== 'agent')", 'if (false)'],
  'report-recipient': ['apps/host/src/goal-delegation-owner.ts', "if (owner.kind !== 'agent')", 'if (false)'],
  'participation-session': ['apps/host/src/goal-participation-owner.ts', "created.kind !== 'agent'", "created.kind === 'retired-agent'"],
  'delegation-notice': ['apps/host/src/goal-delegation-attention.ts', "if (supervisor.kind !== 'agent') throw new Error('The original Supervisor creation is unconfirmed. Its reminder remains retained.')", "if (supervisor.kind !== 'agent') Object.assign(supervisor, { run: supervisor.observation?.retainedRun ?? { runId: 'unconfirmed-observation' } })"],
  'start-notice': ['apps/host/src/goal-start-responsibility.ts', "if (supervisor.kind !== 'agent') throw new Error('The original Supervisor creation is unconfirmed. Its exact responsibility remains retained.')", "if (supervisor.kind !== 'agent') Object.assign(supervisor, { run: supervisor.observation?.retainedRun ?? { runId: 'unconfirmed-observation' } })"],
  'spatial-observation-run': ['apps/host/src/spatial-agent-control.ts', "if (session.kind !== 'agent') throw new AgentMuxError('The original creation is not a committed Session. Its exact prepared or closed receipt is retained.', 'AGENT_CREATION_UNCONFIRMED')",
    "if (session.kind !== 'agent') Object.assign(session, { run: session.observation?.retainedRun ?? { runId: 'unconfirmed-observation' } })"]
} as const
const mutation = process.env.HOST_CREATION_MUTANT
if (mutation && !Object.hasOwn(mutations, mutation)) throw Error('Unknown creation consumer mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.local/mote-host-creation-contract/cache'),
  plugins: [{ name: 'fixed-creation-consumer-workspace', enforce: 'pre', resolveId(id) {
    if (id === '@agentmux/identity/runtime-source') return resolve(root, 'packages/identity/dist/runtime-source.js')
    const match = /^@agentmux\/([^/]+)(.*)$/u.exec(id)
    if (!match) return
    const directory = resolve(root, match[1] === 'host' ? 'apps/host' : 'packages/' + match[1])
    if (!existsSync(resolve(directory, 'package.json'))) return
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    const entry = manifest.exports?.[match[2] ? '.' + match[2] : '.']?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory,
      entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    let served = source
    const selected = mutation ? mutations[mutation as keyof typeof mutations] : null
    if (selected && selected[0] === path) {
      if (source.split(selected[1]).length !== 2) throw Error('Creation mutation must identify one owning expression')
      served = source.replace(selected[1], selected[2])
    }
    if (/\.[cm]?[jt]sx?$/u.test(id.split('?')[0]!) && process.env.HOST_CREATION_SOURCE_TRACE && /^(?:apps\/(?:host|desktop)|packages\/[^/]+)\/src\//u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = JSON.stringify({ path, sha256: hash(source), loadedSHA256: hash(served), mutation: served === source ? null : mutation }) + '\n'
      return { code: "import { appendFileSync as __hostCreationLoad } from 'node:fs'; __hostCreationLoad(" +
        JSON.stringify(process.env.HOST_CREATION_SOURCE_TRACE) + ',' + JSON.stringify(row) + ');\n' + served, map: null }
    }
    return served === source ? undefined : { code: served, map: null }

  } }, ...(original.plugins ?? [])],
  test: { ...original.test, include: ['apps/host/test/goal-participation-owner.test.ts',
    'apps/desktop/test/goal-delegation-owner.test.ts', 'apps/desktop/test/goal-delegation-attention.test.ts',
    'apps/desktop/test/goal-start-responsibility.test.ts', 'apps/host/test/spatial-creation-inspection.test.ts'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false }
})
