import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({ ...base, cacheDir: '.tmp/retained-consumer-notifications-vitest', plugins: [{
  name: 'retained-consumer-source-qualification', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!), hash = (value: string) => createHash('sha256').update(value).digest('hex')
    let code = original
    const speakerInverse = process.env.AGENTMUX_PANE_SPEAKER_INVERSE
    if (speakerInverse) assert.ok(['restore-imperative-metadata', 'forget-project-membership'].includes(speakerInverse))
    let speakerMutated = false
    if (path === 'apps/desktop/src/renderer/src/components/SessionPane.tsx' && speakerInverse === 'restore-imperative-metadata') {
      const anchor = 'metadata.get(id) ?? currentConversationSpeakerMetadata(id, {'
      assert.equal(code.split(anchor).length - 1, 1)
      code = code.replace(anchor, 'currentConversationSpeakerMetadata(id, {')
      speakerMutated = true
    }
    if (path === 'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts') {
      if (speakerInverse === 'forget-project-membership') {
        const membership = 'value = [state.config?.workspaces, ...speakerIds.flatMap(id => {'
        assert.equal(code.split(membership).length - 1, 1)
        code = code.replace(membership, 'value = [undefined, ...speakerIds.flatMap(id => {')
        speakerMutated = true
      }
      const anchor = 'export function createConversationSpeakerMetadataReader(snapshot: SpeakerSnapshot) {'
      assert.equal(code.split(anchor).length - 1, 1)
      code = code.replace(anchor, anchor + '\n  ;(globalThis as any).__agentmuxConversationSpeakerMetadataRead?.()')
    }
    if (path === 'apps/desktop/src/renderer/src/components/SessionPane.tsx' && process.env.AGENTMUX_PANE_SNAPSHOT_INVERSE) {
      assert.equal(process.env.AGENTMUX_PANE_SNAPSHOT_INVERSE, 'restore-unused-snapshot')
      const anchor = '  const firstPromptSelector = useMemo(() => createFirstPromptSelector(sessionId), [sessionId])'
      assert.equal(code.split(anchor).length - 1, 1)
      code = code.replace(anchor, "  const timelineSnapshot = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.timelines[sessionId])\n" + anchor)
    }
    if (process.env.AGENTMUX_PANE_SNAPSHOT_LOADED && (path.startsWith('apps/desktop/src/') || path.endsWith('/retained-consumer-notifications.test.tsx')))
      appendFileSync(process.env.AGENTMUX_PANE_SNAPSHOT_LOADED, JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(code), ...(speakerMutated ? { speakerInverse } : {}) }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/retained-consumer-notifications.test.tsx'] } })
