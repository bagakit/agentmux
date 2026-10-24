import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'
const anchor = 'headerVisibility?.[channel.adapterId] !== false'
export default defineConfig({ ...base, plugins: [...base.plugins!, {
  name: 'platform-control-loaded-counterexample', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path !== 'apps/desktop/src/renderer/src/components/ConnectorHeaderLinks.tsx') return
    let loaded = original
    if (process.env.PLATFORM_CONTROL_MUTANT) {
      if (process.env.PLATFORM_CONTROL_MUTANT !== 'ignore-display-choice' || original.split(anchor).length !== 2) throw Error('Unknown or missing platform visibility counterexample')
      loaded = original.replace(anchor, 'true')
    }
    if (!process.env.PLATFORM_CONTROL_LOADED) return loaded === original ? undefined : loaded
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const marker = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), mutant: process.env.PLATFORM_CONTROL_MUTANT ?? null }
    return { code: "import { appendFileSync as __platformLoaded } from 'node:fs'; __platformLoaded(" + JSON.stringify(process.env.PLATFORM_CONTROL_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/platform-service-control.test.tsx', 'apps/desktop/test/platform-service-binding.test.tsx'], passWithNoTests: false } })
