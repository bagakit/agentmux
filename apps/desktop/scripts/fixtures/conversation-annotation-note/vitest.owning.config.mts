import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-quality-artifacts/T003/cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'conversation-annotation-loaded-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code
      const mutation = process.env.AGENTMUX_CONVERSATION_ANNOTATION_MUTATION
      const changes: Record<string, { file: string; from: string; to: string }> = {
        'wrong-range': { file: 'ConversationAnnotationNote.tsx', from: 'left: rect.left, top: rect.bottom - 1', to: 'left: 0, top: rect.bottom - 1' },
        'empty-range': { file: 'ConversationAnnotationNote.tsx', from: 'Array.from(target.range.getClientRects())', to: '([] as DOMRect[])' },
        'drop-id': { file: 'SessionPane.tsx', from: 'Regarding message ${JSON.stringify(annotation.messageId)}:', to: 'Regarding this message:' }
      }
      const change = mutation ? changes[mutation] : undefined
      if (change && file === `${root}/apps/desktop/src/renderer/src/components/${change.file}`) {
        if (before.split(change.from).length !== 2) throw new Error(`Missing unique annotation mutation ${mutation}`)
        code = before.replace(change.from, change.to)
      }
      const log = process.env.AGENTMUX_CONVERSATION_ANNOTATION_LOADED_SOURCE
      if (log) {
        mkdirSync(dirname(log), { recursive: true })
        appendFileSync(log, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) })}\n`)
        if (code !== before) writeFileSync(`${log}.${change!.file}.transformed.txt`, code)
      }
      if (code !== before) return { code, map: null }
    }
  }, {
    name: 'conversation-annotation-compiled-source',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!['ConversationAnnotationNote.tsx', 'SessionPane.tsx'].some(name => file === `${root}/apps/desktop/src/renderer/src/components/${name}`)) return
      const log = process.env.AGENTMUX_CONVERSATION_ANNOTATION_LOADED_SOURCE
      if (!log) return
      const output = `${log}.${file.endsWith('SessionPane.tsx') ? 'SessionPane' : 'ConversationAnnotationNote'}.compiled.js`
      writeFileSync(output, code)
      appendFileSync(`${log}.compiled.jsonl`, `${JSON.stringify({ path: relative(root, file), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), output })}\n`)
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-annotation-following-note.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
