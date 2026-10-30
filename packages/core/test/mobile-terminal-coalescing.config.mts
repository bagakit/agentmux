import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const alias: Array<{ find: RegExp; replacement: string }> = []
for (const name of readdirSync(resolve(root, 'packages'))) {
  const directory = resolve(root, 'packages', name), manifest = resolve(directory, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : (value as { import?: string })?.import
    if (!entry?.startsWith('./dist/')) continue
    const source = resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    if (existsSync(source)) alias.push({ find: new RegExp('^' + (key === '.' ? pkg.name : pkg.name + key.slice(1)).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'), replacement: source })
  }
}
const control = 'apps/mobile/src/terminal/control.ts'
const variants = {
  unbatched: { path: control, from: 'index < queue.length', to: 'index < 1', pattern: '12-event burst' },
  'cross-resize': { path: control, from: "if (next.kind !== 'input' || next.run.runId !== intent.run.runId) break",
    to: "if (next.kind !== 'input') { count++; continue }\n            if (next.run.runId !== intent.run.runId) break", pattern: 'keeps original binary' },
  'binary-transcode': { path: control, from: "parts.push(typeof next.data === 'string' ? new TextEncoder().encode(next.data) : next.data)",
    to: "parts.push(typeof next.data === 'string' ? new TextEncoder().encode(next.data) : new TextEncoder().encode(new TextDecoder().decode(next.data)))", pattern: 'keeps original binary' },
  'wrong-byte-count': { path: control, from: 'state.queuedBytes - byteLength(intent.data)', to: 'state.queuedBytes - count', pattern: 'keeps original binary' },
  'replay-batch': { path: control, from: '// Raw input has no caller-owned operation ID.', to: "queue.unshift(intent); if (intent.kind === 'input') publish({ queuedBytes: state.queuedBytes + byteLength(intent.data) })\n          // Raw input has no caller-owned operation ID.", pattern: 'retains one original unknown batch' },
  'disconnect-viewer': { path: 'apps/mobile/src/terminal/MobileTerminalViewer.tsx', from: 'binding.send(data, source)', to: 'void data', pattern: 'mounted original Viewer' }
} as const
const mutation = process.env.AGENTMUX_RELAY_INPUT_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown original Mobile source mutant')
export default defineConfig({ root, resolve: { alias }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.tmp/relay-input-test-cache', mutation ?? 'normal'),
  plugins: [{ name: 'original-relay-input-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(packages|apps)\/.+\.(ts|tsx)$/u.test(path)) return
    const selected = mutation && variants[mutation]
    let code = original
    if (selected && path === selected.path) {
      if (original.split(selected.from).length !== 2) throw Error('Source mutant must replace one exact production expression: ' + mutation)
      code = original.replace(selected.from, selected.to)
    }
    const loaded = process.env.AGENTMUX_RELAY_INPUT_LOADED
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (loaded) appendFileSync(loaded, JSON.stringify({ path, originalSHA256: hash(original), servedSHA256: hash(code), ...(code === original ? {} : { mutation }) }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }], test: { include: ['packages/core/test/mobile-terminal-coalescing.test.ts', 'apps/mobile/test/terminal-control.test.ts',
      'apps/mobile/test/terminal-viewer-initial-binding.test.tsx'],
    environment: 'node', environmentMatchGlobs: [['apps/mobile/test/terminal-viewer-initial-binding.test.tsx', 'happy-dom']],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10_000, hookTimeout: 15_000,
    ...(process.env.AGENTMUX_RELAY_INPUT_PATTERN ? { testNamePattern: process.env.AGENTMUX_RELAY_INPUT_PATTERN } : {}) } })

export { variants }
