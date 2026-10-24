import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..'), marker = process.env.MARKDOWN_RESOURCE_LOADED
export default defineConfig({ ...original, plugins: [...original.plugins!, {
  name: 'markdown-resource-consumer-proof', enforce: 'pre',
  transform(source, id) {
    if (!/\/packages\/(core|connectors)\/src\/.+\.ts$/u.test(id)) return
    let code = source
    if (process.env.MARKDOWN_RESOURCE_MUTANT === 'drop-images' && id.endsWith('/publication-markdown.ts')) {
      const anchor = 'const imageNodes = markdownImageReferences(text)'
      if (code.split(anchor).length !== 2) throw Error('Markdown business mutation requires the actual node resolver')
      code = code.replace(anchor, 'const imageNodes: ReturnType<typeof markdownImageReferences> = []')
    }
    if (process.env.MARKDOWN_RESOURCE_MUTANT === 'replace-unread-image' && id.endsWith('/publication-store.ts')) {
      const anchor = ' || preserveResources.has(publicationPartKey(piece.part))'
      if (code.split(anchor).length !== 2) throw Error('Image retention mutation requires the actual original intent owner')
      code = code.replace(anchor, '')
    }
    if (process.env.MARKDOWN_RESOURCE_MUTANT === 'author-boundary' && id.endsWith('/session-history-resource-read.ts')) {
      const anchor = "if (originalKind !== 'assistant-message' || part?.contentEligibility !== 'public' || part.contentRole === 'tool' || part.contentRole === 'reasoning')"
      if (code.split(anchor).length !== 2) throw Error('Author mutation requires the exact resource qualification')
      code = code.replace(anchor, 'if (false)')
    }
    if (process.env.MARKDOWN_RESOURCE_MUTANT === 'user-path' && id.endsWith('/publication-host.ts')) {
      const anchor = "item.kind !== 'assistant-message' ? undefined : publicationMarkdown"
      if (code.split(anchor).length !== 2) throw Error('User path mutation requires the actual Host conversion boundary')
      code = code.replace(anchor, 'publicationMarkdown')
    }
    if (marker) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { file: id, original: hash(source), loaded: hash(code) }
      code = "import { appendFileSync as __markdownLoaded } from 'node:fs'; __markdownLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  }
}], cacheDir: resolve(root, '.cache/markdown-resource'), test: { ...original.test,
  include: ['packages/core/test/session-history-resource.test.ts', 'packages/core/test/native-session-preview.test.ts', 'packages/connectors/test/recorded-image-publication-consumer.test.ts'],
  testNamePattern: process.env.MARKDOWN_RESOURCE_MUTANT === 'replace-unread-image' ? 'an unavailable Markdown image reread'
    : process.env.MARKDOWN_RESOURCE_MUTANT === 'author-boundary' ? 'requires the exact original assistant|rechecks the original author|qualifies original Markdown image authors'
    : process.env.MARKDOWN_RESOURCE_MUTANT === 'user-path' ? 'shares public user Markdown'
    : process.env.MARKDOWN_RESOURCE_MUTANT ? 'renders two original Markdown images'
    : 'original Markdown image nodes|qualifies original Markdown image authors|shares public user Markdown|renders two original Markdown images|keeps code examples inert|an unknown Markdown image upload|an unavailable Markdown image reread',
  testTimeout: 30_000, passWithNoTests: false
} })
