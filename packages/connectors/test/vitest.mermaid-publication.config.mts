import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..'), marker = process.env.MERMAID_LOADED, mutation = process.env.MERMAID_MUTANT
if (mutation && !['disconnect', 'rerender'].includes(mutation)) throw Error('Unknown Mermaid consumer mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/mermaid-publication'),
  plugins: [...original.plugins!, { name: 'original-mermaid-owner', enforce: 'pre',
    transform(source, id) {
      if (!/\/(packages\/(core|connectors)|apps\/host)\/src\/.+\.ts$/u.test(id)) return
      let code = source
      if (mutation === 'disconnect' && id.endsWith('/publication-markdown.ts')) {
        const anchor = '...markdownDiagrams(text)'
        if (code.split(anchor).length !== 2) throw Error('The actual Mermaid product consumer is required')
        code = code.replace(anchor, '...[]')
      }
      if (mutation === 'rerender' && id.endsWith('/publication-store.ts')) {
        const anchor = 'return value.segments?.find(segment => {'
        if (code.split(anchor).length !== 2) throw Error('The original derived image owner is required')
        code = code.replace(anchor, 'if (true) return undefined; ' + anchor)
      }
      if (marker) {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex')
        const row = { file: id, original: hash(source), loaded: hash(code) }
        code = "import { appendFileSync as __mermaidLoaded } from 'node:fs'; __mermaidLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
      }
      return code === source ? undefined : { code, map: null }
    }
  }], test: { ...original.test,
    include: ['packages/connectors/test/mermaid-renderer.test.ts', 'packages/connectors/test/recorded-image-publication-consumer.test.ts', 'apps/host/test/mermaid-publication-consumer.test.ts'],
    testNamePattern: mutation ? 'Mermaid diagrams reach' : 'Mermaid', testTimeout: 45_000, passWithNoTests: false
  }
})
