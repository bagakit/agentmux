import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './channel-metadata-watch.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.CONNECTOR_TARGET_MUTANT
const variants = {
  'invent-empty-region': ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'target: structuredClone(target)', 'target: { ...target, regionAnchor: { ...target.regionAnchor } }'],
  'drop-session-only-intent': ['apps/desktop/src/renderer/src/lib/connector-room-intent.ts', 'input.regionAnchor?.regionId !== target.regionAnchor?.regionId', 'input.regionAnchor.regionId !== target.regionAnchor.regionId'],
  'accept-foreign-region': ['apps/desktop/src/renderer/src/lib/connector-room-intent.ts', 'input.regionAnchor?.regionId !== target.regionAnchor?.regionId', 'false']
} as const
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown connector target mutation')
export default defineConfig({ ...original, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'actual-connector-target-owner', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'apps/desktop/src/renderer/src/lib/connector-room-intent.ts', 'apps/desktop/src/renderer/src/store.ts'].includes(path)) return
  const selected = mutation ? variants[mutation as keyof typeof variants] : undefined
  let loaded = source
  if (selected && path === selected[0]) {
    if (source.split(selected[1]).length !== 2) throw Error('The exact connector target mutation must match once')
    loaded = source.replace(selected[1], selected[2])
  }
  if (process.env.CONNECTOR_TARGET_TRACE) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(loaded !== source ? { mutation } : {}) }
    return { code: "import { appendFileSync as __connectorTargetLoad } from 'node:fs'; __connectorTargetLoad(" + JSON.stringify(process.env.CONNECTOR_TARGET_TRACE) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
  return loaded === source ? undefined : loaded
} }, ...original.plugins!], test: { ...original.test, include: ['apps/desktop/test/connector-room-target-consumer.test.tsx'], testTimeout: 25_000 } })
