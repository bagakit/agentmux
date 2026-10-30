import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
import owners from './channel-metadata-watch.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { connectionMutations } from './focus-agent-connection-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.FOCUS_CONNECTIONS_MUTANT
const selected = connectionMutations.find(item => item.label === mutation)
if (mutation && !selected) throw Error('Unknown Focus Connections mutation')
const sources = new Set(connectionMutations.map(item => item.file).concat([
  'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx',
  'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx',
  'apps/desktop/src/main/connector-ipc.ts', 'packages/connectors/src/room-target.ts',
  'packages/connectors/src/room-binding.ts', 'packages/connectors/src/room-provisioning.ts'
]))

export default defineConfig({ ...source, plugins: [{ name: 'actual-focus-connections-source', enforce: 'pre', transform(original, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!sources.has(path)) return
  let loaded = original
  if (selected?.file === path) {
    if (original.split(selected.before).length !== 2) throw Error('The Focus Connections production mutation must match exactly once')
    loaded = original.replace(selected.before, selected.after)
  }
  const trace = process.env.FOCUS_CONNECTIONS_TRACE
  if (trace) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(trace, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded !== original ? { mutation } : {}) }) + '\n')
  }
  return original === loaded ? undefined : loaded
} }, ...owners.plugins ?? [], ...source.plugins ?? []],
  test: { ...source.test, include: ['apps/desktop/test/focus-agent-connections.test.tsx', 'apps/desktop/test/connector-room-target-consumer.test.tsx'], testTimeout: 25_000, hookTimeout: 15_000 } })
