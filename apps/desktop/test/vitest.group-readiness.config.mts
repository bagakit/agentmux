import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_GROUP_READINESS_MUTATION
if (mutation && mutation !== 'omit-inline-service') throw Error('Unknown group readiness mutation')
export default defineConfig({ ...original, root, plugins: [{ name: 'actual-group-service-consumer', enforce: 'pre', transform(source, id) {
  if (relative(root, id.split('?')[0]!) !== 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx') return
  const anchor = '<ConnectorServiceControl active />'
  if (source.split(anchor).length !== 2) throw Error('Expected one original group service control')
  const code = mutation ? source.replace(anchor, '{null}') : source
  if (process.env.AGENTMUX_GROUP_READINESS_LOADED) appendFileSync(process.env.AGENTMUX_GROUP_READINESS_LOADED, JSON.stringify({
    file: relative(root, id.split('?')[0]!), mutation: mutation ?? null,
    originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex')
  }) + '\n')
  return code === source ? undefined : { code, map: null }
} }], test: { ...original.test, include: [
  'apps/desktop/test/group-connection-overview.test.tsx', 'apps/desktop/test/connector-header-access.test.tsx', 'apps/desktop/test/connector-menu-contribution.test.tsx'
], fileParallelism: false, passWithNoTests: false } })
