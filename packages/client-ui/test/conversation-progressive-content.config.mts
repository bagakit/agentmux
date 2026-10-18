import mobileBase from '../../../apps/mobile/test/conversation-controllers.config.mts'
import desktop from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_BODY_MUTATION
const mobile = process.env.AGENTMUX_BODY_MOBILE === '1' || mutation === 'restore-resumes-follow'
const base = mobile ? mobileBase : desktop
const edits: Record<string, { file: string; from: string; to: string }> = {
  'restore-resumes-follow': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', from: "programmatic === 'restore'", to: 'false' },
  'mount-all': { file: 'packages/client-ui/src/components/ConversationProgressiveBody.tsx', from: 'useState(!work || !heavy)', to: 'useState(true)' },
  'unmount-away': { file: 'packages/client-ui/src/components/ConversationProgressiveBody.tsx', from: '{mounted ? children :', to: '{mounted && active ? children :' },
  'drop-anchor-compensation': { file: 'packages/client-ui/src/lib/conversation-body-work.ts', from: '  restore(): void {', to: '  restore(): void { return;' },
  'drop-controlled-retention': { file: 'packages/client-ui/src/components/NativeProcessObservation.tsx', from: 'const [readOnce, setReadOnce] = useState(expanded)\n  useEffect(() => { if (expanded) setReadOnce(true) }, [expanded])\n  const bodyId', to: 'const [readOnce, setReadOnce] = useState(false)\n  const bodyId' }
}
if (mutation && !edits[mutation]) throw new Error('Unknown first-body mutation')
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-progressive-' + (mutation ?? 'base'), plugins: [...base.plugins ?? [], {
  name: 'progressive-body-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!/^(packages|apps|test)\//u.test(path) || path.includes('/node_modules/')) return
    let code = source
    const edit = mutation ? edits[mutation] : undefined
    if (edit && path === edit.file) {
      if (source.split(edit.from).length !== 2) throw new Error('Missing unique first-body mutation: ' + mutation)
      code = source.replace(edit.from, edit.to)
    }
    if (process.env.AGENTMUX_BODY_LOADED) appendFileSync(process.env.AGENTMUX_BODY_LOADED,
      JSON.stringify({ path, fileSHA256: hash(readFileSync(file)), originalSHA256: hash(source), sha256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, testNamePattern: mobile ? 'authenticated Mobile preserves detached reading when layout restoration lands near the tail' : undefined,
  include: mobile ? ['test/conversation-protocol-consumer.test.tsx'] : ['packages/client-ui/test/conversation-progressive-content.test.tsx', ...(mutation ? [] : [
  'packages/client-ui/test/conversation-presentation.test.tsx', 'packages/client-ui/test/conversation-long-message.test.tsx', 'packages/client-ui/test/captured-process-record.test.tsx',
  'packages/client-ui/test/readonly-image-preview.test.tsx', 'apps/desktop/test/native-process-reading.test.tsx',
  'apps/desktop/test/conversation-reading-transaction.test.tsx'
])], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
