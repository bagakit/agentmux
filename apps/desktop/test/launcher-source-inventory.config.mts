import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx'
const mutation = process.env.AGENTMUX_LAUNCHER_INVENTORY_MUTATION
if (mutation && mutation !== 'unknown-as-empty') throw Error('Unknown Launcher inventory mutation')
export default { ...base, cacheDir: resolve(root, '.tmp/launcher-source-inventory'),
  plugins: [...base.plugins ?? [], { name: 'launcher-original-inventory-proof', enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (relative(root, id.split('?')[0]!) !== owner) return
      let code = source
      if (mutation) {
        const from = 'sourceMode ? sourceLauncher.inventoryState !== \'ready\' :'
        if (!source.includes(from)) throw Error('Original inventory mutation anchor missing')
        code = source.replace(from, 'sourceMode ? false :')
      }
      if (process.env.AGENTMUX_LAUNCHER_INVENTORY_LOADED) appendFileSync(process.env.AGENTMUX_LAUNCHER_INVENTORY_LOADED,
        JSON.stringify({ file: owner, mutation: mutation ?? null, original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
      return { code, map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/launcher-source-ui.test.tsx'], passWithNoTests: false, testTimeout: 20000, hookTimeout: 20000 }
}
