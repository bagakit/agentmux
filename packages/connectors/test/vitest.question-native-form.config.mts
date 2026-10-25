import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-question-card.config.mts'

const files = ['packages/connectors/src/adapters/feishu/question-card.ts', 'packages/connectors/src/adapters/feishu/action.ts', 'packages/connectors/src/adapters/feishu/index.ts']
export default defineConfig({ ...original, cacheDir: '.cache/question-native-form', plugins: [{
  name: 'question-native-form-loaded-source', enforce: 'pre', transform(source, id) {
    const path = relative(original.root!, id.split('?')[0]!)
    if (!files.includes(path)) return
    let loaded = source, mutation: string | undefined
    const mutant = process.env.QUESTION_NATIVE_MUTANT
    if (mutant && !['disconnect-submit-fields', 'remove-refusal-feedback'].includes(mutant)) throw Error('Unknown Question native form mutation')
    const anchor = mutant === 'disconnect-submit-fields' && path === files[0]
      ? ['questionFields: fields', 'questionFields: []']
      : mutant === 'remove-refusal-feedback' && path === files[2]
        ? ["if (content) return { toast: { type: 'warning', content } }", 'if (content) return {}'] : undefined
    if (anchor) {
      if (source.split(anchor[0]!).length !== 2) throw Error('Question native form mutation anchor must occur once')
      loaded = source.replace(anchor[0]!, anchor[1]!); mutation = mutant
    }
    if (process.env.QUESTION_NATIVE_LOADED) {
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      const row = { path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }
      loaded = "import { appendFileSync as __questionNativeLoaded } from 'node:fs'; __questionNativeLoaded(" + JSON.stringify(process.env.QUESTION_NATIVE_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded
    }
    return loaded === source ? undefined : { code: loaded, map: null }
  }
}, ...original.plugins!], test: { ...original.test, include: ['packages/connectors/test/feishu-question-actions.test.ts'],
  testNamePattern: process.env.QUESTION_NATIVE_CASE ?? 'default Desktop and authenticated Feishu form|correctable original Question partial|invalid Question feedback|invalid Question during|native select changes',
  fileParallelism: false, passWithNoTests: false } })
