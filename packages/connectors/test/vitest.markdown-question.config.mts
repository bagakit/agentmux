import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import original from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MARKDOWN_QUESTION_MUTANT
if (mutation && mutation !== 'drop-form') throw Error('Unknown Markdown question mutation')
export default defineConfig({ ...original, cacheDir: '.cache/markdown-question', plugins: [{ ...original.plugins![0] as Plugin,
  name: 'original-markdown-question-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|connectors)\/(src|test)\/.+\.ts$/u.test(path)) return
    let code = source
    if (mutation && path === 'packages/connectors/src/publication-store.ts') {
      const anchor = '? questionRepresentation(payload, { ...question, ...(plan.phase ? { phase: plan.phase } : {}) }) : payload'
      if (source.split(anchor).length !== 2) throw Error('The original mixed question seam must be unique')
      code = source.replace(anchor, '? payload : payload')
    }
    const marker = process.env.MARKDOWN_QUESTION_LOADED
    if (marker) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }
      code = "import { appendFileSync as __markdownQuestionLoaded } from 'node:fs'; __markdownQuestionLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['packages/connectors/test/discord-channel.test.ts'], testNamePattern: 'mixed Markdown typed question', passWithNoTests: false } })
