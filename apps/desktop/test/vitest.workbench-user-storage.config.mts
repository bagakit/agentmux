import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_USER_STORAGE_MUTATION
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/workbench-user-storage-cache-' + (mutation ?? 'candidate')),
  plugins: [...base.plugins ?? [], { name: 'native-user-storage-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file === 'apps/desktop/src/renderer/src/store.ts') {
      source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
      if (mutation === 'disconnect-native') {
        const anchor = ': nativeWorkbenchStorage'
        if (source.split(anchor).length !== 2) throw Error('Missing native storage consumer mutation anchor')
        source = source.replace(anchor, ': nonBrowserWorkbenchStorage')
      }
      return { code: source, map: null }
    }
    if (mutation === 'drop-newer-input' && file === 'apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts') {
      const anchor = 'pending.get(name) === value'
      if (source.split(anchor).length !== 2) throw Error('Missing late ACK mutation anchor')
      return { code: source.replace(anchor, 'true'), map: null }
    }
    if (mutation === 'bypass-atomic-import' && file === 'apps/desktop/src/renderer/src/lib/workbench-user-storage.ts') {
      const anchor = 'const imported = await port.importWorkbenchState(held)'
      if (source.split(anchor).length !== 2) throw Error('Missing atomic native import mutation anchor')
      return { code: source.replace(anchor, 'await port.writeWorkbenchState(held)\n      const imported = held'), map: null }
    }
    if (mutation === 'drop-clear-barrier' && file === 'apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts') {
      const anchor = 'if (removals.has(name)) continue'
      if (source.split(anchor).length !== 2) throw Error('Missing per-key clear barrier mutation anchor')
      return { code: source.replace(anchor, 'if (false) continue'), map: null }
    }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-user-storage.test.ts', 'apps/desktop/test/workbench-user-state-consumer.test.ts'],
    passWithNoTests: false }
})
