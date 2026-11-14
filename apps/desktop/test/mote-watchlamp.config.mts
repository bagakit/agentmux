import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './mote-reliability.config.mts'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'guess-manual-pause': { file: 'mote-heartbeat-presentation.ts', before: 'const reason = schedule.pause?.reason', after: "const reason = schedule.pause?.reason ?? (schedule.lastMutation?.action === 'pause' ? 'manual' : undefined)" },
  'guess-pause-time': { file: 'MoteHeartbeatStatus.tsx', before: "schedule.pause?.pausedAt !== undefined ? <Stamp value={schedule.pause.pausedAt} />", after: "schedule.lastTickAt !== undefined ? <Stamp value={schedule.lastTickAt} />" },
  'ignore-main-change': { file: 'mote-heartbeat-presentation.ts', before: 'return !changed', after: 'return true' },
  'hide-read-failure': { file: 'mote-heartbeat-presentation.ts', before: "if (unavailable || !reading || reading.status === 'unconfirmed')", after: "if (!reading || reading.status === 'unconfirmed')" },
  'accept-late-read': { file: 'mote-heartbeat-reading.ts', before: '}).then(saved => {\n      if (!disposed && cut === generation && !document.hidden) {', after: '}).then(saved => {\n      if (!disposed && !document.hidden) {' },
  'discard-original-pause': { file: 'mote-heartbeat-reading.ts', before: 'saved: unavailable && state.saved ? state.saved : saved', after: 'saved' },
  'keep-old-revision-green': { file: 'mote-heartbeat-reading.ts', before: "publish({ ...state, unavailable: true, issue: 'The original settings changed. Reading this revision before confirming automatic care.' })", after: 'void state' },
  'keep-terminal-source': { file: 'mote-heartbeat-reading.ts', before: 'if (sourceChanged) { needsSource = true; requested = true }', after: 'void sourceChanged' },
  'lose-original-reminder': { file: 'MoteHeartbeatLamp.tsx', before: 'setOriginal(intent.original)', after: 'setOriginal(undefined)' },
  'lose-reminder-return-focus': { file: 'MoteHeartbeatLamp.tsx', before: 'invoker.current?.isConnected ? invoker.current : button.current', after: 'invoker.current?.isConnected ? invoker.current : null' },
  'borrow-new-pending-input': { file: 'MoteQuickMode.tsx', before: 'const pending = originalHeartbeat ? originalHeartbeat.schedule.pendingCompletion : result.schedule.pendingCompletion', after: 'const pending = result.schedule.pendingCompletion' }
}
const selected = process.env.MOTE_WATCHLAMP_MUTATION
if (selected && !mutations[selected]) throw Error('Unknown Mote watch lamp source mutation')
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'mote-watchlamp-production-mutation', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, mutation = selected ? mutations[selected] : undefined
    if (!file.includes('/src/') || !Object.values(mutations).some(value => file.endsWith('/' + value.file))) return
    let loaded = source
    if (mutation && file.endsWith('/' + mutation.file)) {
      if (source.split(mutation.before).length !== 2) throw Error('Exactly one real production anchor is required')
      loaded = source.replace(mutation.before, mutation.after)
    }
    if (process.env.MOTE_WATCHLAMP_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_WATCHLAMP_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), loadedSHA256: hash(loaded), mutation: source === loaded ? null : selected }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/mote-reliability.test.tsx'] } })
