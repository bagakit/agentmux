import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/question-gap-recovery'),
  plugins: [...(source.plugins ?? []), { name: 'actual-question-gap-owner', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.tsx?$/u.test(path)) return
    const original = code
    if (process.env.QUESTION_GAP_MUTANT && path === 'packages/connectors/src/publication-store.ts') {
      const anchor = 'const accepted = questionReads && acceptQuestionReads(questionReads, questionsRead)'
      if (code.split(anchor).length !== 2) throw Error('Question gap recovery mutation anchor is missing or ambiguous')
      code = code.replace(anchor, 'const accepted = questionReads && acceptQuestionReads(questionReads, new Set<string>())')
    }
    const marker = process.env.QUESTION_GAP_LOADED
    if (!marker) return code === original ? undefined : { code, map: null }
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: sha256(original), loadedSHA256: sha256(code), ...(code !== original ? { mutation: 'question-read-disconnected' } : {}) }) + '\n'
    return { code: "import { appendFileSync as __markQuestionGap } from 'node:fs'; __markQuestionGap(" + JSON.stringify(marker) + ', ' + JSON.stringify(row) + ');\n' + code, map: null }
  } }],
  test: { ...source.test, include: ['packages/connectors/test/question-gap-recovery-consumer.test.ts'],
    environment: 'node', passWithNoTests: false, fileParallelism: false, testTimeout: 30_000 } })
