import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { owner: string; from: string; to: string; include: string; filter: string }> = {
  'terminal-reveal-dropped': { owner: 'components/TerminalView.tsx', from: '      terminalRef.current?.scrollToBottom()\n    }\n    target.focus()',
    to: '    }\n    target.focus()', include: 'terminal-webgl-visibility.test.tsx', filter: 'an explicit Open terminal handoff' },
  'terminal-reveal-forgets-memory': { owner: 'components/TerminalView.tsx', from: "      viewportMemoryRef.current = { kind: 'latest' }\n", to: '',
    include: 'terminal-webgl-visibility.test.tsx', filter: 'Activity view lands' },
  'terminal-reveal-repeats': { owner: 'components/TerminalView.tsx', from: ' && revealedCaretNonceRef.current !== request.nonce', to: '',
    include: 'terminal-webgl-visibility.test.tsx', filter: 'reveals once' },
  'attention-panel-reveal-dropped': { owner: 'components/AttentionRequestPanel.tsx',
    from: 'openSessionTerminal(session.id, useAppStore.getState().workbenchSpaceSelection?.regionId)', to: 'openSessionTerminal(session.id)',
    include: 'attention-request-craft.test.tsx', filter: 'keeps Open terminal available' },
  'session-pane-reveal-dropped': { owner: 'components/SessionPane.tsx', from: 'openSessionTerminal(sessionId, linkOrigin.regionId)',
    to: 'openSessionTerminal(sessionId)', include: 'main-region-session-pane.test.tsx', filter: 'Open terminal' }
}
const mutation = process.env.AGENTMUX_PERMISSION_REVEAL_MUTATION
const selected = mutation ? mutations[mutation] : undefined
if (mutation && !selected) throw new Error('Unknown permission terminal source mutation: ' + mutation)
export default defineConfig({ ...source,
  cacheDir: resolve(root, '.local/allowbash-takeover/terminal-vitest-cache', mutation ?? 'positive'),
  plugins: [...(source.plugins ?? []), { name: 'original-permission-terminal-owner', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!selected || path !== 'apps/desktop/src/renderer/src/' + selected.owner) return
    if (code.split(selected.from).length !== 2) throw new Error('Terminal mutation anchor must match exactly once: ' + mutation)
    const changed = code.replace(selected.from, selected.to)
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const receipt = process.env.AGENTMUX_PERMISSION_REVEAL_LOADED
    if (!receipt) throw new Error('A production mutation needs its loaded source receipt')
    appendFileSync(receipt, JSON.stringify({ mutation, path, originalSHA256: sha(code), sha256: sha(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { ...source.test, passWithNoTests: false,
    include: (selected ? [selected.include] : ['terminal-webgl-visibility.test.tsx', 'attention-request-craft.test.tsx', 'main-region-session-pane.test.tsx'])
      .map(file => 'apps/desktop/test/' + file),
    testNamePattern: selected?.filter ?? 'Open terminal|Activity view lands|reveals once|ordinary navigation keeps the reading position',
    maxWorkers: 1, fileParallelism: false }
})
