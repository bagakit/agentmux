import { defineConfig } from 'vitest/config'
import original from './native-resource.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const repository = resolve(import.meta.dirname, '../../..')
const changes = {
  optin: ['packages/client-ui/src/components/AgentMarkdown.tsx', 'readOnlyImages = false', 'readOnlyImages = true'],
  record: ['packages/client-ui/src/components/ConversationResourceImage.tsx', 'resource.recordId !== recordId ||', 'false ||'],
  realm: ['packages/client-ui/src/lib/use-visible-work.ts', 'const owner = target.ownerDocument, view = owner.defaultView', 'const owner = document, view = owner.defaultView'],
  passive: ['packages/client-ui/src/components/ConversationImage.tsx', 'if (!interactive) return <span ref={viewport.ref}', 'if (false && !interactive) return <span ref={viewport.ref}']
} as const
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
export default defineConfig({ ...original, cacheDir: resolve(repository, '.tmp/agent-input-recall/media-cache'),
  plugins: [{ name: 'original-readonly-media', enforce: 'pre', transform(code, id) {
    const path = relative(repository, id.split('?')[0]!)
    if (!path.startsWith('packages/client-ui/src/') && !path.startsWith('packages/client-ui/test/')) return
    const mutation = process.env.AGENT_RECALL_MEDIA_MUTATION as keyof typeof changes | undefined
    let served = code
    if (mutation) {
      if (!changes[mutation]) throw Error('Unknown media mutation: ' + mutation)
      const [target, needle, replacement] = changes[mutation]
      if (path === target) {
        if (code.split(needle).length !== 2) throw Error('One exact loaded media target is required: ' + mutation)
        served = code.replace(needle, replacement)
      }
    }
    if (process.env.AGENT_RECALL_MEDIA_LOADED) appendFileSync(process.env.AGENT_RECALL_MEDIA_LOADED,
      JSON.stringify({ path, sourceSha256: sha(code), servedSha256: sha(served), mutated: served !== code,
        testSha256: sha(readFileSync(resolve(repository, 'packages/client-ui/test/readonly-image-preview.test.tsx'))),
        configSha256: sha(readFileSync(resolve(import.meta.dirname, 'readonly-image-preview.config.mts'))) }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...original.test, include: ['test/readonly-image-preview.test.tsx', 'test/conversation-native-resource.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
