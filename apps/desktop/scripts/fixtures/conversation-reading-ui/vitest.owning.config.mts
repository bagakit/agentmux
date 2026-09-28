import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')

export default defineConfig({
  ...original,
  root,
  plugins: [
    ...(original.plugins ?? []),
    {
      name: 'conversation-reading-ui-loaded-source',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0]!
        if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
        const originalCode = code
        const mutation = process.env.AGENTMUX_CONVERSATION_READING_MUTATION

        if (mutation) {
          if (file === `${root}/apps/desktop/src/renderer/src/components/ConversationMessage.tsx`) {
            const partsDefinition =
              "const parts: readonly AgentSessionHistoryContentPart[] = isStringContent\n    ? [{ kind: 'text', text: content }]\n    : content"

            const partsMutations: Record<string, string> = {
              'remove-text-parts':
                "const parts: readonly AgentSessionHistoryContentPart[] = (isStringContent\n    ? [{ kind: 'text', text: content }]\n    : content).filter((p) => p.kind !== 'text')",
              'remove-reasoning-parts':
                "const parts: readonly AgentSessionHistoryContentPart[] = (isStringContent\n    ? [{ kind: 'text', text: content }]\n    : content).filter((p) => p.kind !== 'reasoning')",
              'remove-tool-parts':
                "const parts: readonly AgentSessionHistoryContentPart[] = (isStringContent\n    ? [{ kind: 'text', text: content }]\n    : content).filter((p) => p.kind !== 'tool-call' && p.kind !== 'tool-result')",
              'remove-resource-parts':
                "const parts: readonly AgentSessionHistoryContentPart[] = (isStringContent\n    ? [{ kind: 'text', text: content }]\n    : content).filter((p) => p.kind !== 'resource')"
            }

            if (partsMutations[mutation]) {
              const replacement = partsMutations[mutation]!
              if (!code.includes(partsDefinition)) {
                throw new Error(`Missing parts definition target for mutation ${mutation}`)
              }
              code = code.replace(partsDefinition, replacement)
            }
          }

          if (file === `${root}/apps/desktop/src/renderer/src/components/ConversationReasoningTrace.tsx`) {
            const markdownBlock =
              `<div className="log-turn__trace-body">\n              <MemoizedAgentMarkdown\n                content={part.text}\n                workspaceRoot={workspaceRoot}\n                {...(openWorkspaceFile ? { openWorkspaceFile } : {})}\n                {...(readPastedImage ? { readPastedImage } : {})}\n                {...(openHttpLink ? { openHttpLink } : {})}\n              />\n            </div>`

            const rawFallback =
              `<pre className="log-turn__trace-raw-fallback">\n              {part.text}\n            </pre>`

            if (mutation === 'reasoning-raw-text') {
              if (!code.includes(markdownBlock)) {
                throw new Error(`Missing markdownBlock target for reasoning-raw-text`)
              }
              code = code.replace(markdownBlock, rawFallback)
            } else if (mutation === 'reasoning-always-mounted') {
              if (!code.includes('{open ? (')) {
                throw new Error(`Missing {open ? ( target for reasoning-always-mounted`)
              }
              code = code.replace('{open ? (', '{true ? (')
            }
          }
        }

        const destination = process.env.AGENTMUX_CONVERSATION_READING_LOADED_SOURCE
        if (destination) {
          appendFileSync(
            destination,
            `${JSON.stringify({
              path: relative(root, file),
              originalSHA256: createHash('sha256').update(originalCode).digest('hex'),
              sha256: createHash('sha256').update(code).digest('hex'),
              bytes: Buffer.byteLength(code),
              ...(mutation && code !== originalCode ? { mutation } : {})
            })}\n`
          )
        }
        if (code !== originalCode) return { code, map: null }
      }
    }
  ],
  cacheDir: resolve(root, '.tmp/conversation-reading-ui-cache'),
  test: {
    ...original.test,
    include: ['apps/desktop/test/conversation-reading-ui.integration.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
