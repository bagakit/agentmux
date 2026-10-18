import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.AGENTMUX_SELECTED_ANCHOR_MUTATION
if (mutation && !['ignore-selected-original', 'ignore-visible-cross-range', 'accept-group-endpoint'].includes(mutation)) throw new Error('Unknown selected-anchor mutation')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-selected-anchor-' + (mutation ?? 'base'), plugins: [...base.plugins ?? [], {
  name: 'selected-anchor-source-proof', enforce: 'pre', transform(source, id) {
    if (!id.endsWith('/packages/client-ui/src/lib/conversation-reading-anchor.ts')) return
    const from = mutation === 'accept-group-endpoint'
      ? 'selected && isLeaf(selected) && root.contains(selected)'
      : mutation === 'ignore-visible-cross-range'
      ? '  const selected = element?.closest<HTMLElement>(selector)'
      : '  visible: (node: HTMLElement) => boolean, candidates: () => Iterable<Element>): HTMLElement | null {'
    if (source.split(from).length !== 2) throw new Error('Missing unique selected-anchor owner')
    const replacement = mutation === 'accept-group-endpoint' ? 'selected && root.contains(selected)'
      : from + (mutation === 'ignore-visible-cross-range' ? '\n  if (!selected || !visible(selected)) return null;' : '\n  return null;')
    const code = mutation ? source.replace(from, replacement) : source
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SELECTED_ANCHOR_LOADED) appendFileSync(process.env.AGENTMUX_SELECTED_ANCHOR_LOADED,
      JSON.stringify({ file: id, mutation: mutation ?? null, originalSHA256: hash(source), compiledSHA256: hash(code) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/conversation-presentation.test.tsx',
  'packages/client-ui/test/conversation-progressive-content.test.tsx', 'apps/desktop/test/conversation-earlier-anchor.test.ts'],
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false } })
