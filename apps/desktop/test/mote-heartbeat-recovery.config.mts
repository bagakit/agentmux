import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './mote-watchlamp.config.mts'

const mutations: Record<string, [string, string]> = {
  'hide-checked-recovery': ['{checkedMissingKey ? <div', '{false ? <div'],
  'missing-receipts-mean-missing-key': ['!maintenance.schedule.pendingCompletion && moteHeartbeatReadingMatchesSource(saved)', '!originalInput?.input && !originalInput?.record && moteHeartbeatReadingMatchesSource(saved)'],
  'skip-current-resume-source': ['if (!existing) await confirmCurrentHeartbeat(schedule!, original.ownerHostId)', 'if (false) await confirmCurrentHeartbeat(schedule!, original.ownerHostId)'],
  'skip-current-inspection-source': ['if (!originalHeartbeat) await confirmCurrentHeartbeat(schedule, ownerHostId)', 'if (false) await confirmCurrentHeartbeat(schedule, ownerHostId)'],
  'forget-resume-operation': ['actions={!originalHeartbeat && resumeRequest.current ?', 'actions={false ?'],
  'retain-undispatched-resume': ['const epoch = lifetime.current\n    let dispatched = Boolean(existing)', 'resumeRequest.current = original\n    const epoch = lifetime.current\n    let dispatched = Boolean(existing)'],
  'reuse-checked-generation': ['schedule.providerId, schedule.workspacePath, schedule.revision, schedule.managedSource?.sourceId, schedule.managedSource?.revision, schedule.pause?.episodeId, schedule.lastTickId,', 'schedule.providerId, schedule.workspacePath,'],
  'resume-original-reminder': ['const checkedMissingKey = !originalHeartbeat &&', 'const checkedMissingKey =']
}
const selected = process.env.MOTE_RECOVERY_MUTATION
if (selected && !mutations[selected]) throw Error('Unknown Mote recovery mutation')
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'mote-recovery-production-mutation', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    const quickMode = file.endsWith('/src/renderer/src/components/MoteQuickMode.tsx')
    if (!quickMode && !file.endsWith('/src/renderer/src/components/MoteHeartbeatStatus.tsx')) return
    let loaded = source
    if (selected && quickMode) {
      const [before, after] = mutations[selected]!
      if (source.split(before).length !== 2) throw Error('One real recovery source anchor required')
      loaded = source.replace(before, after)
    }
    if (process.env.MOTE_RECOVERY_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_RECOVERY_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), loadedSHA256: hash(loaded), mutation: source === loaded ? null : selected }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}] })
