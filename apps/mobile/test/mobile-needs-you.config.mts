import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../vitest.config'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.MOBILE_NEEDS_YOU_MUTATION, report = process.env.MOBILE_NEEDS_YOU_LOADED
const variants: Record<string, { file: string; before: string; after: string }> = {
  'drop-unmounted-receipt': { file: 'apps/mobile/src/conversation/use-mobile-interaction-controller.ts', before: 'if (responses.current.get(originalKey) !== original) return', after: 'if (!mounted.current || responses.current.get(originalKey) !== original) return' },
  'late-device-save': { file: 'apps/mobile/src/conversation/use-mobile-interaction-controller.ts', before: 'const retained = await local.save()', after: 'const retained = true' },
  'repeat-confirmed-refresh': { file: 'apps/mobile/src/navigation/MobileNeedsYouAnswer.tsx', before: 'settled && requestKey && answeredRequest.current !== requestKey', after: 'settled && requestKey' },
  'ticket-full-event-stream': { file: 'apps/mobile/src/navigation/MobileNeedsYouAnswer.tsx', before: 'client.onStatusEvent(event =>', after: 'client.onEvent(event =>' },
  'stale-record-owner': { file: 'apps/mobile/src/conversation/local-drafts-owner.tsx', before: 'const local = useMemo(createLocalDrafts, [replacementRevision])', after: 'const local = useMemo(createLocalDrafts, [])' },
  'adopt-external-record': { file: 'apps/mobile/src/conversation/local-drafts-owner.tsx', before: 'useSyncExternalStore(subscribe, device.recordReplacementRevision)', after: 'useSyncExternalStore(subscribe, () => device.recordIdentity())' },
  'forget-unstored-drafts': { file: 'apps/mobile/src/recovery/device-workface.ts', before: 'const drafts = [...this.recordReplacementListeners.values()].flatMap(read => read?.() ?? [])', after: 'const drafts: UnstoredConversationDraft[] = []' },
  'omit-mote-source': { file: 'apps/mobile/src/navigation/MobileNeedsYouAnswer.tsx', before: '...(moteSource ? { moteSource } : {})', after: '...{}' },
  'duplicate-directory-reader': { file: 'apps/mobile/src/MobileApp.tsx', before: 'connected && workspaceVisible, directoryVisible)', after: "connected && workspaceVisible, directoryVisible && home === 'focus')" },
  'silent-attention-failure': { file: 'apps/mobile/src/navigation/use-mobile-attention-catalog.ts', before: 'if (!disposed) publish(client, undefined, error instanceof Error ? error.message : String(error))', after: 'void error' },
  'rerender-identical-attention': { file: 'apps/mobile/src/navigation/use-mobile-attention-catalog.ts', before: 'if (previous.client === source && previous.items === nextItems && previous.confirmed === confirmed && previous.issue === issue) return previous', after: 'if (false) return previous' }
}
if (mutation && !variants[mutation]) throw Error('Unknown needs-you mutation')
const runtime = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
export default defineConfig({ ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/mobile-needs-you', mutation ?? 'normal'),
  plugins: [...base.plugins!, { name: 'needs-you-source-consumers', enforce: 'pre',
    resolveId(id) { if (id === '@agentmux/identity/runtime-source') return '\0needs-you-identity'; return workspaceSourceExport(root, id) },
    load(id) { if (id === '\0needs-you-identity') return runtime },
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!/^apps\/mobile\/src\//u.test(file)) return
      const variant = mutation ? variants[mutation] : undefined
      let code = original
      if (variant?.file === file) {
        if (code.split(variant.before).length !== 2) throw Error('Mutation must replace one actual production block: ' + mutation)
        code = code.replace(variant.before, variant.after)
      }
      if (report) {
        const sha = (value: string) => createHash('sha256').update(value).digest('hex')
        appendFileSync(report, JSON.stringify({ file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: variant?.file === file ? mutation : null }) + '\n')
      }
      return code === original ? undefined : { code, map: null }
    }
  }], test: { ...base.test, include: ['test/mobile-needs-you-answer.test.tsx', 'test/mobile-needs-you-navigation.test.tsx', 'test/mobile-attention-catalog.test.tsx',
      'test/conversation-surface.test.tsx', 'test/mobile-navigation-consumers.test.tsx', 'test/concurrent-drafts.test.tsx', 'test/manual-input-receipt.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
