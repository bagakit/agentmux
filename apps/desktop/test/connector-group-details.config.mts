import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'

const mutations = {
  'default-skips-overview': ['apps/desktop/src/renderer/src/lib/connector-group-status.ts', "return { kind: 'overview', label: 'View group details' }", "return { kind: 'activity', label: 'View group details' }"],
  'stop-detail-observation': ['apps/desktop/src/renderer/src/components/ConnectorDeliveryDetails.tsx', 'active, null, hostingTarget, [binding])', 'active, null, hostingTarget, [])'],
  'hide-profile-freshness': ['apps/desktop/src/renderer/src/components/ConnectorEntityIdentity.tsx', '{profileRead?.issue ?', '{false ?']
} as const
const mutant = process.env.GROUP_DETAILS_MUTANT as keyof typeof mutations | undefined
if (mutant && !mutations[mutant]) throw Error('Unknown group details mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-group-details'), plugins: [...base.plugins!, {
  name: 'group-details-loaded-candidate', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    const selected = mutant && mutations[mutant]
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('Group detail mutation anchor changed')
      loaded = original.replace(selected[1], selected[2])
    }
    if (!process.env.GROUP_DETAILS_LOADED) return loaded === original ? undefined : { code: loaded, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: original === loaded ? null : mutant }
    return { code: "import { appendFileSync as __groupDetailsLoaded } from 'node:fs'; __groupDetailsLoaded(" + JSON.stringify(process.env.GROUP_DETAILS_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-details-modern.test.tsx', 'apps/desktop/test/application-member-access.test.tsx', 'apps/desktop/test/mote-private-chat-profile.test.tsx', 'apps/desktop/test/connector-input-recovery.test.tsx'], testNamePattern: /routes off-state recovery|opens the original saved connector input|opens View group details|observes the exact visible group|shows the original cached profile|shows source failure|starts with compact|copies the observed original person|keeps late entity profile|shows creator unlimited/, passWithNoTests: false, fileParallelism: false } })
