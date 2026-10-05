import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T003/cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'conversation-annotation-loaded-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code
      const mutation = process.env.AGENTMUX_CONVERSATION_ANNOTATION_MUTATION
      const changes: Record<string, { file: string; from: string; to: string }> = {
        'auto-editor': { file: 'ConversationAnnotationNote.tsx', from: 'setOpened(false); setCopied(false);', to: 'setEdit({ key: crypto.randomUUID(), target, sessionId: sourceSessionId }); setOpened(true); setSelection(null); setCopied(false);' },
        'copy-note': { file: 'ConversationAnnotationNote.tsx', from: 'platform.copyText(original.target.quote,', to: "platform.copyText('wrong selection'," },
        'retarget-draft': { file: 'ConversationAnnotationNote.tsx', from: 'if (edit && note.trim() && !sameTarget(edit, selection))', to: 'if (false && edit && note.trim() && !sameTarget(edit, selection))' },
        'close-discards': { file: 'ConversationAnnotationNote.tsx', from: 'onClick={close}><X', to: 'onClick={discard}><X' },
        'clear-failure': { file: 'ConversationAnnotationNote.tsx', from: 'catch (failure) { setError(`无法将批注', to: "catch (failure) { setNote(''); setError(`无法将批注" },
        'wrong-range': { file: 'ConversationAnnotationNote.tsx', from: 'left: rect.left, top: rect.bottom - 1', to: 'left: 0, top: rect.bottom - 1' },
        'wrong-recipient': { file: 'ConversationAnnotationDelivery.tsx', from: '.send(recipient.id, formatConversationAnnotation', to: '.send(sessionId, formatConversationAnnotation' },
        'retain-hidden-menu': { file: 'ConversationAnnotationDelivery.tsx', from: 'open={active && recipientOpen} onOpenChange={setRecipientOpen}', to: 'open={recipientOpen || !active} onOpenChange={setRecipientOpen}' },
        'retain-hidden-executor-menu': { file: 'ConversationAnnotationDelivery.tsx', from: "{recipient.kind === 'new' && active ? <AgentExecutorPicker", to: "{recipient.kind === 'new' ? <AgentExecutorPicker" },
        'wrong-execution': { file: 'conversation-annotation-delivery.ts', from: 'executionWorkspaceId: workspace.id, prompt:', to: 'executionWorkspaceId: origin.workspaceId, prompt:' },
        'missing-source': { file: 'conversation-annotation-delivery.ts', from: 'Source Agent Session: ${JSON.stringify(sourceSessionId)}\\nRegarding message', to: 'Regarding message' },
        'accept-unknown': { file: 'ConversationAnnotationDelivery.tsx', from: "if (!report.agent || report.agent.initialPrompt !== 'confirmed' || report.agent.creationPersistence === 'unconfirmed' || report.agent.creationFailure)", to: 'if (false)' },
        'inspect-wrong-request': { file: 'ConversationAnnotationDelivery.tsx', from: 'target: { requestId: request.requestId }', to: "target: { requestId: 'another-operation' }" },
        'block-confirmed-partial': { file: 'ConversationAnnotationDelivery.tsx', from: "if (!report.agent || report.agent.initialPrompt !== 'confirmed' || report.agent.creationPersistence === 'unconfirmed' || report.agent.creationFailure)", to: "if (report.outcome !== 'opened' || !report.agent || report.agent.initialPrompt !== 'confirmed' || report.agent.creationPersistence === 'unconfirmed' || report.agent.creationFailure)" }
      }
      const change = mutation ? changes[mutation] : undefined
      if (mutation && !Object.hasOwn(changes, mutation)) throw new Error(`Unknown annotation mutation ${mutation}`)
      // Mutation gates also require a changed loaded row and a nonempty AssertionRED report.
      if (change && file.endsWith(`/${change.file}`)) {
        if (before.split(change.from).length !== 2) throw new Error(`Missing unique annotation mutation ${mutation}`)
        code = before.replace(change.from, change.to)
      }
      const log = process.env.AGENTMUX_CONVERSATION_ANNOTATION_LOADED_SOURCE
      if (log) {
        mkdirSync(dirname(log), { recursive: true })
        appendFileSync(log, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) })}\n`)
        if (code !== before) writeFileSync(`${log}.${change!.file}.transformed.txt`, code)
      }
      if (code !== before) return { code, map: null }
    }
  }, {
    name: 'conversation-annotation-compiled-source',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!['ConversationAnnotationNote.tsx', 'SessionPane.tsx'].some(name => file === `${root}/apps/desktop/src/renderer/src/components/${name}`)) return
      const log = process.env.AGENTMUX_CONVERSATION_ANNOTATION_LOADED_SOURCE
      if (!log) return
      const output = `${log}.${file.endsWith('SessionPane.tsx') ? 'SessionPane' : 'ConversationAnnotationNote'}.compiled.js`
      writeFileSync(output, code)
      appendFileSync(`${log}.compiled.jsonl`, `${JSON.stringify({ path: relative(root, file), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), output })}\n`)
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-annotation-following-note.integration.test.tsx', 'apps/desktop/test/conversation-annotation-delivery.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
