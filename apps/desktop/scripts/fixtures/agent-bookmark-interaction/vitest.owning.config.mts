import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import shared from '../agent-input-recall/vitest.recall.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, cacheDir: '.tmp/agent-bookmark-interaction/vitest', plugins: [...shared.plugins ?? [], {
  name: 'pinned-window-consumers', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), mode = process.env.PINNED_WINDOW_MUTATION
    const mutations: Record<string, [string, string, string]> = {
      size: ['apps/desktop/src/renderer/src/lib/use-agent-bookmark-window.ts', 'Math.max(1, bounds.height)', 'Math.max(260, bounds.height)'],
      hover: ['apps/desktop/src/renderer/src/components/AgentInputRecap.tsx', "event.pointerType === 'touch' || request.pinned", "event.pointerType === 'touch'"],
      pointer: ['apps/desktop/src/renderer/src/lib/use-agent-bookmark-window.ts', 'onPointerCancel(event: ReactPointerEvent<HTMLElement>) { if (event.pointerId === gesture.current?.pointerId) end(false) }', 'onPointerCancel() { end(false) }']
    }
    const mutation = mode ? mutations[mode] : undefined
    let served = code
    if (mutation && path === mutation[0]) { if (code.split(mutation[1]).length !== 2) throw Error('Expected one exact pinned-window mutation'); served = code.replace(mutation[1], mutation[2]) }
    if (process.env.PINNED_WINDOW_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.PINNED_WINDOW_LOADED, JSON.stringify({ path, sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served === code ? undefined : { code: served, map: null }
  }
}], test: { ...shared.test, include: ['apps/desktop/test/agent-bookmark-interaction.test.tsx', 'apps/desktop/test/agent-bookmarks.integration.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
