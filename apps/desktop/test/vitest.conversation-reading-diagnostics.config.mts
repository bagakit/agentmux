import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const hook = 'packages/client-ui/src/lib/use-conversation-view.ts'
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const mutations: Record<string, [string, string, string]> = {
  'drop-assembly': [hook, "note({ phase: 'assembly-complete', attemptId: attempt.id, operation: kind, ...conversationDiagnosticFrame(complete) })", 'void 0'],
  'skip-superseded': [hook, "note({ phase: 'read-superseded', attemptId: current.attempt.id, operation: current.attempt.operation, reason: 'navigation' })", 'void 0'],
  'drop-deferred-publication': [hook, "publishedDeferral = next; flush('progress')", 'publishedDeferral = next'],
  'reuse-lifetime': [hook, 'consumerId: crypto.randomUUID()', 'consumerId: reporting.ownerInstanceId'],
  'visible-before-owner': [activity,
    '  useEffect(() => {\n    if (!conversationReading?.enabled) return\n    const visible = documentVisible && conversationReading.consumer?.visible !== false',
    '  useLayoutEffect(() => {\n    if (!conversationReading?.enabled) return\n    const visible = documentVisible && conversationReading.consumer?.visible !== false'],
  'ignore-reading-identity': [activity,
    "readingWindow.noteDiagnostic({ phase: visible ? 'consumer-visible' : 'consumer-hidden', ...(visible ? {} : { reason: 'hidden' }) })\n  }, [conversationReading?.enabled, conversationReading?.consumer?.visible, conversationReading?.identity,\n    conversationReading?.reference.hostId, conversationReading?.reference.agentSessionId, documentVisible, readingWindow.noteDiagnostic])",
    "readingWindow.noteDiagnostic({ phase: visible ? 'consumer-visible' : 'consumer-hidden', ...(visible ? {} : { reason: 'hidden' }) })\n  }, [conversationReading?.enabled, conversationReading?.consumer?.visible, documentVisible, readingWindow.noteDiagnostic])"]
}
const owners = [hook, 'packages/client-ui/src/lib/conversation-reading-diagnostics.ts', 'packages/core/src/reading-diagnostic-recorder.ts',
  'packages/core/src/reading-diagnostic.ts', 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts',
  activity, 'apps/desktop/src/renderer/src/lib/reading-diagnostic-publication.ts',
  'apps/desktop/src/renderer/src/lib/reading-client-incident.ts', 'apps/desktop/src/renderer/src/lib/client-incident-recorder.ts',
  'apps/desktop/src/renderer/src/lib/client-incident-dispatcher.ts', 'apps/host/src/client-incident-archive.ts',
  'apps/desktop/src/main/client-incident-ipc.ts', 'packages/core/src/client-incident.ts',
  'packages/core/src/diagnostic-evidence-service.ts', 'packages/core/src/diagnostic-evidence-codec.ts', 'packages/core/src/public-rpc-service.ts']
export default defineConfig({ ...base, cacheDir: '.cache/conversation-reading-diagnostics', plugins: [...base.plugins ?? [], {
  name: 'reading-diagnostic-consumer-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const mutation = process.env.AGENTMUX_READING_DIAGNOSTIC_MUTATION
    const edit = mutation ? mutations[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown reading diagnostic mutation')
    let output = source
    if (edit && edit[0] === path) {
      if (source.split(edit[1]).length !== 2) throw new Error('Reading diagnostic mutation must match exactly once')
      output = source.replace(edit[1], edit[2])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_READING_DIAGNOSTIC_LOADED) appendFileSync(process.env.AGENTMUX_READING_DIAGNOSTIC_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(output), mutation: output === source ? null : mutation }) + '\n')
    return output === source ? undefined : { code: output, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-reading-diagnostics.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20000 } })
