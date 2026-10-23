import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.AGENTMUX_SELECTED_ANCHOR_MUTATION
const exactRestoreLookup = `  const id = CSS.escape(anchor.id)
  const row = anchor.kind === 'segment'
    ? viewport.querySelector<HTMLElement>(\`[data-segment-key='\${id}']\`)
    : anchor.kind === 'record'
    ? viewport.querySelector<HTMLElement>(\`[data-native-record-id='\${id}']\`)
    : viewport.querySelector<HTMLElement>(\`[data-observation-id='\${id}']\`)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')`
const enumeratedRestoreLookup = `  const row = anchor.kind === 'segment'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.dataset.segmentKey === anchor.id)
    : anchor.kind === 'record'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => node.dataset.nativeRecordId === anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')`
if (mutation && !['ignore-selected-original', 'ignore-visible-cross-range', 'accept-group-endpoint', 'scan-known-anchor-candidates'].includes(mutation)) throw new Error('Unknown selected-anchor mutation')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-selected-anchor-' + (mutation ?? 'base'), plugins: [...base.plugins ?? [], {
  name: 'selected-anchor-source-proof', enforce: 'pre', transform(source, id) {
    if (!id.endsWith('/packages/client-ui/src/lib/conversation-reading-anchor.ts')) return
    const from = mutation === 'scan-known-anchor-candidates' ? exactRestoreLookup : mutation === 'accept-group-endpoint'
      ? 'selected && isLeaf(selected) && root.contains(selected)'
      : mutation === 'ignore-visible-cross-range'
      ? '  const selected = element?.closest<HTMLElement>(selector)'
      : '  visible: (node: HTMLElement) => boolean, candidates: () => Iterable<Element>): HTMLElement | null {'
    if (source.split(from).length !== 2) throw new Error('Missing unique selected-anchor owner')
    const replacement = mutation === 'scan-known-anchor-candidates' ? enumeratedRestoreLookup : mutation === 'accept-group-endpoint' ? 'selected && root.contains(selected)'
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
