import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-frame-transport', plugins: [...base.plugins ?? [], {
  name: 'conversation-frame-transport-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!), mutation = process.env.AGENTMUX_FRAME_TRANSPORT_MUTATION
    let code = source, semanticMutation = false
    if (mutation && !['default-page-budget', 'repeat-frame-digests'].includes(mutation)) throw Error('Unknown frame transport mutation')
    if (mutation === 'default-page-budget' && path === 'packages/client-ui/src/lib/use-conversation-view.ts') {
      const anchor = 'maxBytes: CONVERSATION_MAX_READ_BYTES'
      if (source.split(anchor).length !== 3) throw Error('Frame budget mutation needs both original read inputs')
      code = source.replaceAll(anchor, 'maxBytes: 64 * 1024')
      semanticMutation = true
    }
    if (mutation === 'repeat-frame-digests' && path === 'packages/core/src/conversation-reader.ts') {
      const anchor = 'batch.digests.length ? batch.digests : units.map'
      if (source.split(anchor).length !== 2) throw Error('Frame digest mutation needs the frozen owner')
      code = source.replace(anchor, 'units.map')
      semanticMutation = true
    }
    let instrumentation: string | undefined
    if (path === 'packages/core/src/conversation-reader.ts') {
      const anchor = "const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')"
      if (code.split(anchor).length !== 2) throw Error('Hash work observation requires the actual digest owner')
      code = code.replace(anchor, `const hash = (bytes: string | Uint8Array) => {
        const digest = createHash('sha256').update(bytes).digest('hex')
        ;(globalThis as typeof globalThis & { __agentmuxFrameHash?: (bytes: string | Uint8Array) => void }).__agentmuxFrameHash?.(bytes)
        return digest
      }`)
      instrumentation = 'completed-real-unit-hash-work'
    }
    if (process.env.AGENTMUX_FRAME_TRANSPORT_LOADED && /(?:use-conversation-view|conversation-reader|conversation-frame-transport\.test)\.(?:ts|tsx)$/.test(path)) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_FRAME_TRANSPORT_LOADED, JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), bytes: Buffer.byteLength(code), ...(instrumentation ? { instrumentation } : {}), ...(semanticMutation ? { mutation } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-frame-transport.test.tsx'], testTimeout: 20000, passWithNoTests: false } })
