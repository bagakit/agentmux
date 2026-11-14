import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOTE_INITIALIZATION_MUTATION
export default defineConfig({ ...original, plugins: [{ name: 'mote-initialization-original-source', enforce: 'pre',
  resolveId(source) { if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts') },
  transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/host/src/')) return
    let loaded = source
    if (mutation === 'independent-registry' && path === 'apps/host/src/host.ts') {
      const before = 'executors: () => readConfiguredExecutorChoices(configurationPath!),'
      if (source.split(before).length !== 2) throw Error('Original Host preference injection must occur exactly once')
      loaded = source.replace(before, "executors: async () => (await originalRuntime().client.listHostExecutors()).executors.map(value => ({ id: value.executorId, name: value.label, providerId: value.providerId })),")
    }
    if (mutation === 'hide-executor-failure' && path === 'apps/host/src/mote-quick-preferences.ts') {
      const before = 'const executors = await this.ports.executors()'
      if (source.split(before).length !== 2) throw Error('Original preference executor read must occur exactly once')
      loaded = source.replace(before, before + '.catch(() => [])')
    }
    if (mutation === 'eager-launch-validation' && path === 'apps/host/src/mote-resources.ts') {
      const before = 'return Object.entries(executors).flatMap(([id, value]) => {'
      if (source.split(before).length !== 2) throw Error('Original preference choice projection must occur exactly once')
      loaded = source.replace(before, before + '\n    configuredExecutor(raw, id)')
    }
    if (process.env.MOTE_INITIALIZATION_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_INITIALIZATION_LOADED, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(loaded !== source ? { mutation } : {}) }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/mote-initialization.test.ts'], testTimeout: 45_000, maxWorkers: 1, passWithNoTests: false } })
