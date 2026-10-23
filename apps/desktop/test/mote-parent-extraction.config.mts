import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
import { moteParentMutations, mutateMoteParent } from './helpers/mote-parent-node-loader.mjs'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOTE_PARENT_MUTANT
if (mutation && !Object.hasOwn(moteParentMutations, mutation)) throw Error('Unknown finite parent mutation')
const observed = new Set(['packages/connectors/dist/mote-connection-operations.js',
  'apps/desktop/src/main/mote-connection-ipc.ts', 'apps/desktop/src/main/mote-connection-source.ts',
  'apps/host/src/mote-connection-preferences.ts'])
export default defineConfig({ ...original, root, plugins: [{ name: 'actual-package-mote-parent', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!observed.has(path)) return
  const loaded = path.startsWith('packages/connectors/') ? mutateMoteParent(source, mutation) : source
  if (!process.env.MOTE_PARENT_LOADED) return loaded === source ? undefined : loaded
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  const marker = { path, diskSHA256: sha(readFileSync(id.split('?')[0]!)), originalSHA256: sha(source), loadedSHA256: sha(loaded),
    producer: 'evaluated-package-consumer', ...(loaded !== source ? { mutation } : {}) }
  return { code: "import { appendFileSync as __moteParentLoaded } from 'node:fs'; __moteParentLoaded(" + JSON.stringify(process.env.MOTE_PARENT_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
} }, ...(original.plugins ?? [])], test: { ...original.test, fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
  include: ['apps/desktop/test/mote-connection-operation-public-consumer.test.ts', 'apps/desktop/test/bot-task-continuity.test.tsx'] } })
