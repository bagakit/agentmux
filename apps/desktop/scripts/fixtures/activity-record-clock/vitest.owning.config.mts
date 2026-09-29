import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  cacheDir: resolve(root, '.local/state/conversation-agent-message-style-20261004/time-owning-cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'activity-record-clock-loaded-source', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code
      const mutation = process.env.AGENTMUX_ACTIVITY_RECORD_TIME_MUTATION
      if (file === `${root}/apps/desktop/src/renderer/src/components/ActivityView.tsx` && mutation) {
        const rowTime = '<span className="log-row__time" title={recordedTime.offset}>{recordedTime.from}</span>'
        const plainRowTime = '<time className="log-row__time" tabIndex={0} aria-description={recordedTime.offset} title={recordedTime.offset}>{recordedTime.from}</time>'
        if (mutation === 'row-offset-main') {
          if (!code.includes(rowTime) || !code.includes(plainRowTime)) throw new Error('Expected both actual Row time branches')
          code = code.replace(rowTime, rowTime.replace('>{recordedTime.from}', '>{recordedTime.offset}')).replace(plainRowTime, plainRowTime.replace('>{recordedTime.from}', '>{recordedTime.offset}'))
        } else if (mutation === 'group-end-at-last-start') {
          const target = 'const lastRecordedAt = Math.max(...items.map((item) => item.updatedAt))'
          if (!code.includes(target)) throw new Error('Missing actual group maximum-update target')
          code = code.replace(target, 'const lastRecordedAt = items[items.length - 1]!.createdAt')
        } else if (mutation === 'plain-row-time-missing') {
          if (!code.includes(plainRowTime)) throw new Error('Missing actual plain Row time')
          code = code.replace(plainRowTime, '<span className="log-row__time" />')
        } else if (mutation === 'plain-row-keyboard-description-missing') {
          if (!code.includes(plainRowTime)) throw new Error('Missing actual plain Row keyboard time')
          code = code.replace(plainRowTime, plainRowTime.replace(' tabIndex={0} aria-description={recordedTime.offset}', ''))
        } else if (mutation === 'group-offset-description-missing') {
          const target = '<span className="log-fold__time" title={recordedTime.offset}>'
          if (!code.includes(target)) throw new Error('Missing actual group offset description')
          code = code.replace(target, '<span className="log-fold__time">')
        }
      }
      if (file === `${root}/apps/desktop/src/renderer/src/lib/activity-ruler.ts` && mutation === 'cross-day-clock-only') {
        const target = 'if (!crossDay) return formatClock(at)'
        if (!code.includes(target)) throw new Error('Missing actual cross-day formatting branch')
        code = code.replace(target, 'if (true) return formatClock(at)')
      }
      const destination = process.env.AGENTMUX_ACTIVITY_RECORD_TIME_LOADED
      if (destination) appendFileSync(destination, `${JSON.stringify({path: relative(root,file),originalSHA256:createHash('sha256').update(originalCode).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(code!==originalCode?{mutation}: {})})}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/activity-record-clock.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
