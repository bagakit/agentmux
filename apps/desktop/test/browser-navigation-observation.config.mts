import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..'), variant = process.env.BROWSER_NAVIGATION_MUTATION, trace = process.env.BROWSER_NAVIGATION_LOADED
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'main-hides-request-and-error': { file: 'apps/desktop/src/main/browser-view-manager.ts',
    before: `return { requestedUrl: entry.requestedUrl, documentUrl: contents.getURL(), navigationId: entry.navigationId,
      committedNavigationId: entry.committedNavigationId, loading: contents.isLoading(), error: entry.error }`,
    after: `return { requestedUrl: contents.getURL(), documentUrl: contents.getURL(), navigationId: entry.navigationId,
      committedNavigationId: entry.committedNavigationId, loading: contents.isLoading(), error: null }` },
  'codec-drops-navigation': { file: 'packages/core/dist/control-browser-targets.js',
    before: '...(navigation === undefined ? {} : { navigation }),', after: '' }
}
if (variant && !mutations[variant]) throw new Error('Unknown Browser navigation mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const owners = new Set(['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/test/browser-view-manager.test.ts',
  'packages/core/dist/control-browser-targets.js', 'packages/core/dist/control-codec.js', 'packages/core/dist/public-rpc-server.js',
  'packages/browser/src/browser-page-dispatch.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...original,
  cacheDir: resolve(trace ? dirname(trace) : resolve(root, '.tmp/browser-navigation-observation'), 'vite', variant ?? 'baseline'),
  plugins: [...original.plugins ?? [], { name: 'browser-navigation-original-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    const disk = readFileSync(resolve(root, file), 'utf8')
    // Vite blanks a compiled file's source-map directive while preserving its
    // positions. Admit only that exact metadata change, never changed code.
    const masked = disk.replace(/^\/\/[#@] sourceMappingURL=[^\r\n]*$/gm, value => ' '.repeat(value.length))
    if (source !== disk && source !== masked) throw new Error('Unexpected Browser navigation input transform: ' + file)
    let code = source
    if (mutation?.file === file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Browser navigation mutation anchor must match once: ' + variant)
      code = code.replace(mutation.before, mutation.after)
    }
    if (!trace) return code === source ? undefined : code
    const sourceFile = file.startsWith('packages/core/dist/') ? file.replace('/dist/', '/src/').replace(/\.js$/, '.ts') : file
    writeFileSync(resolve(dirname(trace), file.replaceAll('/', '_') + '.input.txt'), source)
    const row = { file, sourceFile, sourceSHA256: sha(readFileSync(resolve(root, sourceFile), 'utf8')),
      diskSHA256: sha(disk), inputTransform: source === disk ? 'none' : 'source-map-comment-blanked',
      mutation: mutation?.file === file ? variant : null, originalSHA256: sha(source), loadedSHA256: sha(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport { appendFileSync as __navigationProof } from 'node:fs'; __navigationProof(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  } }],
  test: { ...original.test, include: ['apps/desktop/test/browser-view-manager.test.ts'],
    testNamePattern: mutation ? 'Browser public navigation observation.*main-frame-event'
      : 'Browser public navigation observation|fences late owner callbacks after a profile switch',
    server: { deps: { inline: ['@agentmux/core'] } }, maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
}
