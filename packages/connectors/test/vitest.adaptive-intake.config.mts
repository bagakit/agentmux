import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/adaptive-intake'), plugins: [{ name: 'adaptive-loaded-source', enforce: 'pre',
  transform(code, id) {
    const changes = {
      'size-and-body': ['agent-message-input.ts', 'const INLINE_MESSAGE_BYTES = 16 * 1024', 'const INLINE_MESSAGE_BYTES = Number.MAX_SAFE_INTEGER'],
      'quote-cut': ['ingress-context.ts', 'if (!channelQuoteWireMatchesEnvelope(admission.intent.prompt,', 'if (false && !channelQuoteWireMatchesEnvelope(admission.intent.prompt,'],
      'field-range': ['agent-message-field-reader.ts', "const item = input.field === 'body' ? body : channelQuote ?? null", "const item = input.field === 'body' ? JSON.stringify(message.envelope) : channelQuote ?? null"]
    } as const
    const change = changes[process.env.ADAPTIVE_INTAKE_MUTANT as keyof typeof changes]
    let loaded = code, mutation: string | undefined
    if (change && id.endsWith(change[0])) {
      if (code.split(change[1]).length !== 2) throw Error('Exact adaptive mutant must load once')
      loaded = code.replace(change[1], change[2]); mutation = process.env.ADAPTIVE_INTAKE_MUTANT
    }
    if (process.env.ADAPTIVE_INTAKE_LOADED && /^packages\/(core|connectors)\/(src|test)\/.+\.(ts|mts)$/u.test(id.slice(root.length + 1))) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.ADAPTIVE_INTAKE_LOADED, JSON.stringify({ path: id.slice(root.length + 1), originalSHA256: sha(code), loadedSHA256: sha(loaded), ...(mutation ? { mutation } : {}) }) + '\n')
    }
    if (mutation) return loaded
  },
  resolveId(source, importer) {
    if (source.startsWith('@agentmux/')) {
      const [name, ...parts] = source.slice('@agentmux/'.length).split('/')
      if (name === 'identity') return
      const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name!, 'package.json'), 'utf8'))
      const entry = manifest.exports[parts.length ? './' + parts.join('/') : '.']?.import
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages', name!, 'src', entry.slice(7).replace(/^src\//u, '').replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: ['packages/connectors/test/adaptive-intake-consumer.test.ts', 'packages/connectors/test/ingress-context.test.ts', 'packages/connectors/test/adaptive-intake-restart.test.ts'], environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 40000 } })
