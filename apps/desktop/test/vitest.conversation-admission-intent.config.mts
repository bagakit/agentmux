import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const owners = ['packages/client-ui/src/lib/use-conversation-view.ts', 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts']
export default defineConfig({ ...base, cacheDir: '.cache/conversation-admission-intent', plugins: [...base.plugins ?? [], {
  name: 'original-host-admission-intent', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const mutation = process.env.AGENTMUX_ADMISSION_INTENT_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'use-latest-host-intent': [owners[1]!, 'replayingHeldIntent ? admissionIntent.current', 'false ? admissionIntent.current'],
      'native-before-captured': [owners[1]!,
        `      if (beforeCapturedCommit?.(next.captured, displayedFrame ? projectConversationWindow(displayedFrame).captured : undefined) === false) return false\n      if (page && !beforeCommit(page, currentIntent, displayed.current ?? undefined, { current: displayed.current,\n        ...(boundary.current ? { recordBoundary: { beforeRecordId: boundary.current } } : {}) })) return false`,
        `      if (page && !beforeCommit(page, currentIntent, displayed.current ?? undefined, { current: displayed.current,\n        ...(boundary.current ? { recordBoundary: { beforeRecordId: boundary.current } } : {}) })) return false\n      if (beforeCapturedCommit?.(next.captured, displayedFrame ? projectConversationWindow(displayedFrame).captured : undefined) === false) return false`],
      'convert-coverage-to-earlier': [owners[1]!, 'replayingHeldIntent ? admissionIntent.current', "replayingHeldIntent ? (operation === 'older' ? 'earlier' : admissionIntent.current)"]
    }
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown host admission mutation')
    let output = source
    if (edit && path === edit[0]) {
      if (source.split(edit[1]).length !== 2) throw new Error('Host admission mutation must match exactly once')
      output = source.replace(edit[1], edit[2])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ADMISSION_INTENT_LOADED) appendFileSync(process.env.AGENTMUX_ADMISSION_INTENT_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(output), mutation: output === source ? null : mutation }) + '\n')
    return output === source ? undefined : output
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-admission-intent.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
