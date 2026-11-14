import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './mote-initialization.config.mts'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'saved-as-active': { file: 'MoteHeartbeatStatus.tsx', before: "reading?.status ?? (loading ? 'unread' : 'unconfirmed')", after: "'active'" },
  'accepted-as-complete': { file: 'MoteHeartbeatStatus.tsx', before: 'Host accepted input · progress is in the conversation', after: 'Work completed' },
  'stale-run-trust': { file: 'MoteStartupStatus.tsx', before: "session.creation?.createdRun?.runId === runId ? session.creation.workspaceTrust : undefined", after: 'true ? session.creation?.workspaceTrust : undefined' },
  'drop-native-waiting': { file: 'MoteStartupStatus.tsx', before: 'if (!frontend && !trustIssue && !starting)', after: 'if (!frontend && !trustIssue)' },
  'skip-submission-record': { file: 'runtime-controller.ts', before: 'return await this.configuredClient(control.hostId).inspectAgentPromptSubmission(key)', after: 'return null' },
  'stale-input-reading': { file: 'MoteQuickMode.tsx', before: 'inputReading?.identity === inputIdentity(maintenance.schedule)', after: 'Boolean(inputReading)' },
  'wrong-main-startup': { file: 'MoteWorkface.tsx', before: 'reference={readingMain} active=', after: 'reference={currentMain ?? readingMain} active=' },
  'auto-reland-main': { file: 'MoteWorkface.tsx', before: 'currentMain && attempt.selected === undefined', after: 'currentMain && attempt.selected !== requested' }
}
const selected = process.env.MOTE_RELIABILITY_UI_MUTATION
if (selected && !mutations[selected]) throw Error('Unknown actual Mote UI mutation')
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'mote-reliability-actual-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, mutation = selected ? mutations[selected] : undefined
    if (!file.includes('/src/') || !Object.values(mutations).some(value => file.endsWith('/' + value.file))) return null
    let loaded = source
    if (mutation && file.endsWith('/' + mutation.file)) {
      if (source.split(mutation.before).length !== 2) throw Error('One exact production mutation anchor required')
      loaded = source.replace(mutation.before, mutation.after)
    }
    if (process.env.MOTE_RELIABILITY_UI_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_RELIABILITY_UI_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), loadedSHA256: hash(loaded), mutation: source === loaded ? null : selected }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/mote-reliability.test.tsx', 'apps/desktop/test/mote-heartbeat-inspection.test.ts', 'apps/desktop/test/mote-initialization.test.tsx', 'apps/desktop/test/mote-quick-mode.test.tsx', 'apps/desktop/test/mote-discussion-threads.test.tsx'] } })
