import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'

const mutations = {
  'omit-current-conversation': ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', '<strong>{original.name}</strong><small> · This conversation</small>', '<strong>Unrelated conversation</strong>'],
  'recollapse-audiences': ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', '<section className="connector-group-details__section" aria-label="Connected audiences"><h3><GroupIcon size={16} aria-hidden="true" />Connected audiences</h3>{audienceReview}</section>', '<details aria-label="Connected audiences"><summary>Connected audiences</summary>{audienceReview}</details>']
} as const
const mutant = process.env.GROUP_CLARITY_MUTANT as keyof typeof mutations | undefined
if (mutant && !mutations[mutant]) throw Error('Unknown group clarity mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-group-clarity'), plugins: [...base.plugins!, {
  name: 'group-clarity-loaded-candidate', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    const selected = mutant && mutations[mutant]
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('Group clarity mutation anchor changed')
      loaded = original.replace(selected[1], selected[2])
    }
    if (!process.env.GROUP_CLARITY_LOADED) return loaded === original ? undefined : { code: loaded, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: original === loaded ? null : mutant }
    return { code: "import { appendFileSync as __groupClarityLoaded } from 'node:fs'; __groupClarityLoaded(" + JSON.stringify(process.env.GROUP_CLARITY_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-details-modern.test.tsx', 'apps/desktop/test/connector-input-recovery.test.tsx', 'apps/desktop/test/connector-room-target-consumer.test.tsx'], testNamePattern: /the mounted Session-only creator|opens View group details|keeps configured paused replies-only|observes the exact visible group|routes off-state recovery|shows the original cached profile|shows source failure|starts with compact|opens the original saved connector input/, passWithNoTests: false, fileParallelism: false } })
