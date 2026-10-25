import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { collaborationMutations } from '../scripts/lib/a2a-collaboration-cases.mjs'

const root = resolve(import.meta.dirname, '../../..')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const mutationName = process.env.AGENTMUX_COLLABORATION_MUTATION
const mutation = collaborationMutations.find(item => item.name === mutationName)
if (mutationName && !mutation) throw new Error('Unknown collaboration source mutation: ' + mutationName)

// Development proof consumes this worktree's source, never another tree's build.
// Qualification of the shipped CLI remains a separate, candidate-bound check.
export default defineConfig({
  root,
  plugins: [{ name: 'a2a-collaboration-source', enforce: 'pre', resolveId(id) {
    // This export is generated runtime text and has no TypeScript source module.
    if (id === '@agentmux/identity/runtime-source') return resolve(root, 'packages/identity/dist/runtime-source.js')
    const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
    if (!match) return
    const directory = resolve(root, 'packages', match[1]!)
    const manifest = resolve(directory, 'package.json')
    if (!existsSync(manifest)) return
    const exported = JSON.parse(readFileSync(manifest, 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']
    const entry = typeof exported === 'string' ? exported : exported?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/'))
      return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  }, transform(code, id) {
    const path = id.split('?')[0]!
    if (path.startsWith(resolve(root, 'packages/core/dist') + '/'))
      throw new Error('A2A source proof cannot consume Core build output.')
    const file = relative(root, path)
    if (!/^(?:packages\/[^/]+\/(?:src|test)|apps\/desktop\/src)\/.*\.tsx?$/u.test(file)) return
    let input = code
    if (mutation?.file === file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Source mutation requires its unique original anchor: ' + mutation.name)
      input = code.replace(mutation.before, mutation.after)
    }
    if (process.env.AGENTMUX_COLLABORATION_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_LOADED,
      JSON.stringify({ file, sourceSHA256: digest(code), compilerInputSHA256: digest(input),
        ...(input !== code ? { mutation: mutation!.name } : {}) }) + '\n')
    if (input !== code) return { code: input, map: null }
  } }],
  test: {
    include: ['packages/core/test/a2a-agent-discovery.test.ts', 'packages/core/test/agent-discovery-hosted.test.ts', 'packages/core/test/a2a-broadcast-events.test.ts', 'packages/core/test/a2a-spawn.test.ts',
      'packages/core/test/a2a-spawn-product.test.ts',
      'packages/core/test/a2a-collaboration-cli.test.ts', 'packages/core/test/a2a-collaboration-spawn-native.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    globalSetup: [], fileParallelism: false, maxWorkers: 1,
    passWithNoTests: false, testTimeout: 15_000, hookTimeout: 15_000
  }
})
