import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_PROCESS_MUTATION
const edits: Record<string, [string, string, string]> = {
  'tool-name-classification': ['packages/client-ui/src/components/CapturedProcessRecord.tsx', "item.kind === 'tool_call' ? 'conversation.tool-call'", "item.kind === 'tool_call' ? item.toolName === 'Bash' ? 'object.terminal' : 'conversation.tool-call'"],
  'drop-diff': ['packages/client-ui/src/components/CapturedProcessRecord.tsx', '<ConversationToolDiff diff={diff} />', 'null'],
  'drop-located-expansion': ['packages/client-ui/src/components/ConversationRecordSequence.tsx', 'if (!locatedRecordId || key === located.current) return', 'if (true) return'],
  'ignore-provenance': ['packages/core/src/conversation-tool-edit.ts', 'if (inputs.length !== 1) return null', 'if (inputs.length !== 1) return claudeToolEdit(item.toolName, item.toolInput)']
}
if (mutation && !edits[mutation]) throw new Error('Unknown process mutation')
export default defineConfig({ ...base, cacheDir: '.cache/captured-process-' + (mutation ?? 'base'), plugins: [...base.plugins ?? [], {
  name: 'process-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/')) return
    let code = source
    const edit = mutation && edits[mutation]
    if (edit && path === edit[0]) {
      if (source.split(edit[1]).length !== 2) throw new Error('Missing process mutation source')
      code = source.replace(edit[1], edit[2])
    }
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PROCESS_LOADED) appendFileSync(process.env.AGENTMUX_PROCESS_LOADED, JSON.stringify({ path, fileSHA256: digest(readFileSync(resolve(root, path))), originalSHA256: digest(source), sha256: digest(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/claude-tool-edit.test.ts', 'packages/client-ui/test/conversation-tool-diff.test.ts', 'apps/desktop/test/activity-view-wiring.test.tsx', 'packages/client-ui/test/captured-process-record.test.tsx', 'apps/desktop/test/native-process-reading.test.tsx', 'apps/desktop/test/conversation-tool-payload-reading.test.tsx'], fileParallelism: false, passWithNoTests: false } })
