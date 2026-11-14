import base from '../vitest.config'
import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), file = 'packages/client-ui/src/components/MarkdownCodeBlock.tsx'
const changes: Record<string, [string, string]> = {
  'replace-selected-code': ['const html = selected ? committed.current!.html : nextHtml', 'const html = nextHtml'],
  'drop-colored-cache-on-hide': ['const candidate = result?.owner === owner ? result.value : null', 'const candidate = inView && result?.owner === owner ? result.value : null']
}
const mutation = process.env.AGENTMUX_CODE_SELECTION_MUTATION
if (mutation && !changes[mutation]) throw Error('Unknown code selection mutation: ' + mutation)
export default defineConfig({ ...base, cacheDir: '.cache/markdown-code-selection', plugins: [{ name: 'code-selection-effective-source', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (path !== file) return
  const change = mutation ? changes[mutation]! : undefined
  if (change && source.split(change[0]).length !== 2) throw Error('Mutation anchor is not unique: ' + mutation)
  const code = change ? source.replace(...change) : source
  if (process.env.AGENTMUX_CODE_SELECTION_LOADED) appendFileSync(process.env.AGENTMUX_CODE_SELECTION_LOADED, JSON.stringify({ path, mutation: mutation ?? null,
    originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
  return change ? { code, map: null } : undefined
}}], test: { ...base.test, include: ['packages/client-ui/test/markdown-code-selection.test.tsx', 'packages/client-ui/test/markdown-rich-blocks.test.tsx'], passWithNoTests: false } })
