import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, { path: string; from: string; to: string }> = {
  'provider-no-range': { path: 'packages/core/src/providers/grok-native-history.ts',
    from: "if (readingRange) contentParts[0] = { kind: 'text', text: record.content, readingRange }", to: 'void readingRange' },
  'provider-nonwhole': { path: 'packages/core/src/providers/grok-native-history.ts',
    from: 'text.startsWith(opening) && text.endsWith(closing)', to: 'text.includes(opening) && text.includes(closing)' },
  'normalizer-no-range': { path: 'packages/core/src/session-history.ts',
    from: "return { kind: 'text', text: part.text, ...(readingRange === undefined ? {} : {\n          readingRange: { start: readingRange.start as number, end: readingRange.end as number }\n        }) }",
    to: "return { kind: 'text', text: part.text }" },
  'normalizer-unbounded': { path: 'packages/core/src/session-history.ts',
    from: 'if (readingRange && (!Number.isSafeInteger(readingRange.start)', to: 'if (false && readingRange && (!Number.isSafeInteger(readingRange.start)' },
  'reading-helper-original': { path: 'packages/core/src/session-user-messages.ts',
    from: 'part.text.slice(part.readingRange.start, part.readingRange.end)', to: 'part.text' },
  'projector-original': { path: 'packages/core/src/session-user-messages.ts', from: '.map(sessionHistoryTextForReading)', to: '.map(part => part.text)' },
  'projector-no-channel': { path: 'packages/core/src/session-user-messages.ts',
    from: '...(item.sourceChannel === undefined ? {} : { channel: item.sourceChannel }),', to: '' }
}
export default defineConfig({ root, cacheDir: resolve(root, '.owned-grok-vite-cache', process.env.AGENTMUX_GROK_READING_MUTANT ?? 'baseline'),
  plugins: [{ name: 'grok-query-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), original = code
    const mutant = process.env.AGENTMUX_GROK_READING_MUTANT
    if (mutant && !mutations[mutant]) throw new Error('Unknown exact Grok reading mutant ' + mutant)
    const mutation = mutant ? mutations[mutant] : undefined
    if (mutation && mutation.path === path) {
      if (code.split(mutation.from).length !== 2) throw new Error('Mutation requires one actual source anchor: ' + mutant)
      code = code.replace(mutation.from, mutation.to)
    }
    const log = process.env.AGENTMUX_GROK_READING_LOADED
    if (log && /^packages\/core\/src\/.*\.ts$/u.test(path)) appendFileSync(log, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
      ...(code === original ? {} : { mutation: mutant }) }) + '\n')
    return code === original ? null : { code, map: null }
  } }],
  test: { include: ['packages/core/test/providers/grok-session-analysis.test.ts'],
    testNamePattern: 'Grok native whole-user-query reading projection', passWithNoTests: false, maxWorkers: 1,
    fileParallelism: false, testTimeout: 20_000 }
})
