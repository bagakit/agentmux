import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './mobile-directory-notices.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOBILE_MOTION_MUTATION, report = process.env.MOBILE_MOTION_LOADED
const edge = 'apps/mobile/src/navigation/use-edge-back.ts', app = 'apps/mobile/src/MobileApp.tsx'
const variants: Record<string, { file: string; before: string; after: string; target: string }> = {
  'goal-no-push': { file: app, before: 'onShowGoals={trigger => { navigationRevision.current++; goalReturn.current', after: 'onShowGoals={trigger => { goalReturn.current', target: 'actual conversation Goal' },
  'terminal-no-push': { file: app, before: 'onShowTerminal={() => { navigationRevision.current++; setWorkface', after: 'onShowTerminal={() => { setWorkface', target: 'actual conversation Goal' },
  'same-push-phase': { file: app, before: "'data-motion-phase': screenMotion.key % 2", after: "'data-motion-phase': 0", target: 'actual conversation Goal' },
  'space-menu-hidden': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: 'hidden={Boolean(context.regionId && activeBack)}', after: 'hidden={Boolean(activeBack)}', target: 'Space tree branch' },
  'generic-loading-title': { file: app, before: "loadingLabel={home === 'mote' ? 'Mote' : home === 'focus' ? 'Focus' : 'Space'}", after: 'loadingLabel="目录"', target: 'real directory in its retained loading header' },
  'non-edge-listener': { file: edge, before: 'if (!touch || touch.clientX > EDGE_START_PX) return', after: 'if (!touch) return', target: 'registers no blocking move' },
  'multi-finger-tracking': { file: edge, before: '      cancel()\n      if (event.touches.length !== 1) return', after: '      if (event.touches.length !== 1) return\n      cancel()', target: 'starting finger identity' },
  'commit-springs-back': { file: edge, before: "element.dataset.edgeBack = 'committed'", after: 'follow(null)', target: 'follows the finger, then calls' }
}
if (mutation && !variants[mutation]) throw Error('Unknown navigation motion mutation')
const variant = mutation ? variants[mutation] : undefined
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/mobile-navigation-motion', mutation ?? 'candidate'),
  plugins: [{ name: 'actual-navigation-motion', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (![edge, app, 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/navigation/defer-mobile-surface.tsx'].includes(file)) return
    let code = original
    if (variant?.file === file) {
      if (code.split(variant.before).length !== 2) throw Error('Actual navigation mutation must match once: ' + mutation)
      code = code.replace(variant.before, variant.after)
    }
    if (report) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: variant?.file === file ? mutation : null }
      code = `import { appendFileSync as __motionLoaded } from 'node:fs'; __motionLoaded(${JSON.stringify(report)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
    }
    return code === original ? undefined : { code, map: null }
  } }, ...(base.plugins ?? [])], test: { ...base.test,
    include: variant ? [variant.file === edge ? 'test/mobile-gestures.test.tsx' : mutation === 'generic-loading-title' ? 'test/mobile-directory-loading.test.tsx' : 'test/mobile-navigation-motion.test.tsx'] : ['test/mobile-navigation-motion.test.tsx', 'test/mobile-directory-loading.test.tsx', 'test/mobile-gestures.test.tsx', 'test/mobile-screen-transition.test.tsx', 'test/mobile-needs-you-navigation.test.tsx', 'test/shell-navigation.test.tsx'],
    testNamePattern: variant?.target, testTimeout: 15000, passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
