import base from '../conversation-message-wrapper/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
// Bind shared package exports to this exact checkout, including when dependency links are reused.
const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
const sharedAliases = Object.entries(manifest.exports).map(([key, value]) => {
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui' + key.slice(1)
  const path = typeof value === 'string' ? value : (value as { browser?: string; types: string }).browser ?? (value as { types: string }).types
  return { name, find: name.includes('*') ? new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.+)') + '$') : name,
    replacement: resolve(root, 'packages/client-ui', path).replace('*', '$1') }
}).sort((a, b) => b.name.length - a.name.length).map(({ name: _, ...alias }) => alias)
const edits: Record<string, [string, string, string]> = {
  'snapshot-splits-process': ['ConversationView.tsx', "record.role === 'observation' ? 'anchor' : 'message'", "record.role === 'observation' ? 'message' : 'message'"],
  'raw-snapshot-preview': ['CapturedConversationMessage.tsx', "conversationReplyPreview(item.content ?? '')", "(item.content ?? '').replace(/\\s+/gu, ' ').slice(0, 180)"],
  'progress-repeats-identity': ['ConversationView.tsx', 'continuation={!original && continuedProgress.has(record.id)', 'continuation={false && !original && continuedProgress.has(record.id)'],
  'hidden-preview-work': ['CapturedConversationMessage.tsx', 'active && observation ? {', 'observation ? {'],
  'hide-original-anchor': ['NativeProcessObservation.tsx', 'keepContentVisible={anchored}', 'keepContentVisible={false}'],
  'activity-keeps-preview-active': ['ActivityView.tsx', 'active={readingEnabled}\n          item={entry.item}', 'active={true}\n          item={entry.item}'],
  'repeat-unknown-status': ['WorkflowObservation.tsx', "!observation.metrics && !compact ?", "!observation.metrics ?"],
}
export default defineConfig({ ...base, resolve: { ...base.resolve, alias: [...sharedAliases, ...base.resolve!.alias as []] }, cacheDir: '.tmp/conversation-reading-density/cache/' + (process.env.AGENTMUX_READING_DENSITY_MUTATION ?? 'baseline'),
  plugins: [{ name: 'reading-density-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, mutation = process.env.AGENTMUX_READING_DENSITY_MUTATION, edit = mutation ? edits[mutation] : undefined
    if (!file.startsWith(process.cwd() + '/') || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/u.test(file)) return
    let code = source
    if (edit && file.endsWith('/' + edit[0])) {
      if (code.split(edit[1]).length !== 2) throw Error('Unique mutation anchor required: ' + mutation)
      code = code.replace(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_READING_DENSITY_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(process.cwd(), file), originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(source === code ? {} : { mutation }) }) + '\n') }
    return source === code ? undefined : { code, map: null }
  } }, ...(base.plugins ?? [])],
  test: { ...base.test, css: true, include: process.env.AGENTMUX_READING_DENSITY_ADJACENT === '1' ? [
    'apps/desktop/test/conversation-source-roles.test.tsx', 'apps/desktop/test/conversation-collected-reply.test.tsx',
    'apps/desktop/test/conversation-chronological-reading.test.tsx', 'apps/desktop/test/conversation-submission-presentation.test.tsx',
    'apps/desktop/test/conversation-process-collapse.test.tsx', 'apps/desktop/test/conversation-landmarks.test.tsx'
  ] : ['apps/desktop/test/conversation-reading-density.test.tsx', 'apps/desktop/test/conversation-reading-activity-density.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
