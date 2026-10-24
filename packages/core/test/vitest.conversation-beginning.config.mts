import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.T030_CORE_MUTANT
if (mutation && mutation !== 'head-as-tail') throw new Error('Unknown beginning-checkpoint mutation')
export default defineConfig({ root,
  plugins: [{ name: 'beginning-checkpoint-loaded', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/core\/(?:src|test)\/.*\.ts$/u.test(path)) return
    const original = code
    if (mutation && path === 'packages/core/src/native-jsonl-history-reader.ts') {
      const from = 'await reader.seekChanges(context.after, context.tail === true)'
      if (code.split(from).length !== 2) throw new Error('Missing unique beginning-checkpoint mutation anchor')
      code = code.replace(from, 'await reader.seekChanges(context.after, context.tail === true || context.head === true)')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const facts = { path, originalSha256: sha(original), loadedSha256: sha(code), ...(code === original ? {} : { mutation }) }
    const trace = process.env.T030_CORE_LOADED
    return trace ? { code: `import { appendFileSync as __beginningTrace } from 'node:fs'; __beginningTrace(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify(facts) + '\n')});\n` + code, map: null } : code === original ? undefined : { code, map: null }
  } }],
  test: { include: ['packages/core/test/conversation-beginning.test.ts'], environment: 'node',
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20_000 }
})
