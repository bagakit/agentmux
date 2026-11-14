import { defineConfig } from 'vitest/config'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import type { Alias } from 'vite'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
// Until Root's unified owner is committed, use its exact current source rather
// than copying that independent implementation or consuming stale shared dist.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const coreRoot = process.env.AGENTMUX_BOOTSTRAP_CORE_ROOT ?? dirname(common)
const mutation = process.env.AGENTMUX_BOOTSTRAP_MUTATION
const edits: Record<string, [string, string, string]> = {
  'main-load-before-recovery': ['apps/desktop/src/main/index.ts', '    await recoverWorkbench()', '    void recoverWorkbench()'],
  'skip-missing-originals': ['apps/desktop/src/main/workbench-recovery-bootstrap.ts', "if (!absent.length) return { state: 'unchanged' }", "if (true) return { state: 'unchanged' }"],
  'unknown-default-write': ['apps/desktop/src/main/workbench-recovery-bootstrap.ts', 'options.user.retainRecoveryGaps(', 'options.user.observe('],
  'disconnect-host-source': ['apps/host/src/host.ts', "recoverySources: [createDesktopStorageRecoverySource(() => desktopClient({ transport: 'unix' }))],", 'recoverySources: [],']
}
if (mutation && !edits[mutation]) throw Error('Unknown bootstrap mutation')
const aliases: Alias[] = []
const manifest = JSON.parse(readFileSync(resolve(coreRoot, 'packages/core/package.json'), 'utf8'))
for (const [entry, value] of Object.entries(manifest.exports ?? {}) as [string, string | { import?: string; browser?: string }][]) {
  const target = typeof value === 'string' ? value : value.browser ?? value.import
  if (!target) continue
  const source = resolve(coreRoot, 'packages/core', target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
  const specifier = '@agentmux/core' + (entry === '.' ? '' : entry.slice(1)), pattern = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (entry.includes('*')) aliases.push({ find: new RegExp('^' + pattern.replace('\\*', '(.*)') + '$'), replacement: source.replace('*', '$1') })
  else if (existsSync(source)) aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: source })
}
aliases.sort((a, b) => String(a.find).includes('(.*)') ? 1 : String(b.find).includes('(.*)') ? -1 : String(b.find).length - String(a.find).length)
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-recovery-bootstrap'),
  server: { ...base.server, fs: { ...base.server?.fs, allow: [root, coreRoot, ...base.server?.fs?.allow ?? []] } },
  resolve: { ...base.resolve, alias: [...aliases, ...base.resolve!.alias as Alias[]] },
  plugins: [...base.plugins ?? [], { name: 'bootstrap-actual-owner-source-proof', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_BOOTSTRAP_SOURCE_PROOF, edit = mutation && edits[mutation]
    let code = source
    if (edit && path === resolve(root, edit[0])) {
      if (!code.includes(edit[1])) throw Error('Missing exact bootstrap mutation anchor')
      code = code.replace(edit[1], edit[2])
    }
    if (output && (path.startsWith(root + '/apps/') || path.startsWith(coreRoot + '/packages/core/src/'))) appendFileSync(output,
      JSON.stringify({ path, sourceTree: path.startsWith(root + '/') ? 'implementation' : 'core-owner-dependency',
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), compiledSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/workbench-recovery-bootstrap.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 40_000 }
})
