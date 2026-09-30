import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const source = 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx'
const restoredEffect = `  const sessionFactsKey = storeSession?.kind === 'agent' ? \`\${storeSession.updatedAt}:\${storeSession.agentSessionUpdatedAt}\` : storeSession?.updatedAt
  const lastFactsKeyRef = useRef(sessionFactsKey)
  useEffect(() => {
    if (lastFactsKeyRef.current !== undefined && lastFactsKeyRef.current !== sessionFactsKey) {
      lastFactsKeyRef.current = sessionFactsKey
      void refresh()
    } else { lastFactsKeyRef.current = sessionFactsKey }
  }, [sessionFactsKey, refresh])
`
const changes: Record<string, [string, string]> = {
  'session-facts-refresh': ['  const messages = useMemo(() => timeline?.items.filter', restoredEffect + '  const messages = useMemo(() => timeline?.items.filter'],
  'swallow-observation-error': ['{observationError ? <div', '{false ? <div'],
  'swallow-frozen-window': ['{windowFrozen ? <div', '{false ? <div']
}
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  plugins: [...(original.plugins ?? []), { name: 'actual-mailbox-consumer', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/apps/desktop/src/') || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const initial = code, mutation = process.env.AGENTMUX_MAILBOX_MUTATION
    if (mutation && relative(root, file) === source) { const change = changes[mutation]; if (!change || code.split(change[0]).length !== 2) throw new Error('Missing unique Mailbox mutation ' + mutation); code = code.replace(change[0], change[1]) }
    const log = process.env.AGENTMUX_MAILBOX_LOADED, hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (log) appendFileSync(log, JSON.stringify({ path: relative(root, file), originalSHA256: hash(initial), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== initial ? { mutation } : {}) }) + '\n')
    if (code !== initial) return { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/session-mailbox-native-observation.integration.test.tsx'], passWithNoTests: false, fileParallelism: false } })
