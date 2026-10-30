import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.CONNECTION_OVERVIEW_MUTANT
const variants = {
  liveness: ['apps/desktop/src/renderer/src/lib/connector-connection-presentation.ts', "receiver?.state === 'ready' && current?.transport.state === 'ready'", "receiver?.state === 'ready' && current?.transport.state === 'ready' && report?.outgoing.value?.sourceObservation?.state === 'ready'"],
  'read-only-recovery': ['apps/desktop/src/renderer/src/components/ConnectorConnectionOverview.tsx', "api.connections.call('connection.delivery.source.recover', scope, host)", "api.connections.call('connection.diagnose', { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision }, host).then(() => ({ disposition: 'joined', observation: { state: 'unknown' } }))"]
} as const
if (mutation && !(mutation in variants)) throw Error('Unknown connection overview mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/connector-connection-overview'), plugins: [...base.plugins!, {
  name: 'connection-overview-loaded', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^(apps\/(desktop|host)|packages\/(core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(file)) return
    let loaded = source
    if (mutation) { const [owner, before, after] = variants[mutation as keyof typeof variants]; if (file === owner) { if (source.split(before).length !== 2) throw Error('Connection overview mutation anchor missing or ambiguous'); loaded = source.replace(before, after) } }
    const path = process.env.CONNECTION_OVERVIEW_LOADED
    if (!path) return source === loaded ? undefined : { code: loaded, map: null }
    const hash = (s: string) => createHash('sha256').update(s).digest('hex'), row = JSON.stringify({ file, source: hash(source), loaded: hash(loaded), mutation: source === loaded ? null : mutation }) + '\n'
    return { code: "import{appendFileSync as __overviewLoaded}from'node:fs';__overviewLoaded(" + JSON.stringify(path) + ',' + JSON.stringify(row) + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-connection-overview.test.tsx', 'apps/desktop/test/connector-receiver-ui.test.tsx'], testNamePattern: /keeps receiving online|preserves current policy|lets the new binding revision|uses the single overview recovery action/, passWithNoTests: false, fileParallelism: false, testTimeout: 35000, hookTimeout: 20000 } })
