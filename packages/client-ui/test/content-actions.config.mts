import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CONTENT_ACTION_MUTATION
const changes = {
  remove: ['packages/client-ui/src/components/InlineComposer.tsx', '.deleteRange({ from: position, to: position + node.nodeSize })', '.deleteRange({ from: position, to: position })'],
  duplicate: ['packages/client-ui/src/components/InlineComposer.tsx', 'const position = getPos()', 'const position = 8'],
  focus: ['packages/client-ui/src/components/InlineComposer.tsx', 'editor.view.focus()\n  }\n  return <>', 'void editor\n  }\n  return <>'],
  editable: ['packages/client-ui/src/components/InlineComposer.tsx', '!current.current.editable || !editor.isEditable || ', ''],
  'detail-bytes': ['packages/client-ui/src/components/ContentCopyButton.tsx', 'await copyText(text,', 'await copyText(text.trim(),'],
  'detail-source': ['packages/client-ui/src/components/ContentCopyButton.tsx', '[text, identity, copyText]', '[text, copyText]'],
  'detail-action': ['packages/client-ui/src/components/ContentCopyButton.tsx', 'actionRef.current === action', 'true'],
  redacted: ['packages/client-ui/src/components/ConversationReasoningTrace.tsx', '!part.redacted && part.text.length > 0', 'part.text.length > 0'],
  'resource-source': ['packages/client-ui/src/components/ConversationResourceText.tsx', 'loaded?.owner === owner ? loaded.value : null', 'loaded?.value ?? null'],
  'resource-state': ['packages/client-ui/src/components/ConversationResourceText.tsx', 'const loading = reading?.owner === owner && reading.loading\n  const error = reading?.owner === owner ? reading.error : null', 'const loading = reading?.loading ?? false\n  const error = reading?.error ?? null'],
  'resource-close': ['packages/client-ui/src/components/ConversationResourceText.tsx', 'onClick={() => { if (!mounted.current || latestOwner.current !== owner) return; pending.current?.abort(); setLoaded(null) }}', 'onClick={() => { pending.current?.abort(); setLoaded(null) }}'],
} as const
export default defineConfig({ root, plugins: [{ name: 'actual-content-action-mutation', enforce: 'pre', transform(source, id) {
  if (!mutation) return
  assert.ok(mutation in changes, 'Unknown mutation')
  const [path, needle, replacement] = changes[mutation as keyof typeof changes]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Actual mutation target must be unique')
  if (process.env.CONTENT_ACTION_MUTATION_HITS) appendFileSync(process.env.CONTENT_ACTION_MUTATION_HITS, path + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { include: ['packages/client-ui/test/composer-image-remove.test.tsx', 'packages/client-ui/test/conversation-image-gallery.test.tsx',
  'packages/client-ui/test/conversation-detail-copy.test.tsx', 'packages/client-ui/test/markdown-code-copy.test.tsx', 'packages/client-ui/test/conversation-leading-context.test.tsx', 'packages/client-ui/test/conversation-native-resource.test.tsx'],
  environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1 } })
