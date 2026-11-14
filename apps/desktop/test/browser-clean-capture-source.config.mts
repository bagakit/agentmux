import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const coreSourceRoot = new URL('../../../packages/core/', import.meta.url)
const coreSourceAliases = Object.entries(JSON.parse(readFileSync(new URL('package.json', coreSourceRoot), 'utf8')).exports as Record<string, { import: string }>)
  .filter(([key]) => key !== '.')
  .map(([key, entry]) => ({
    find: '@agentmux/core/' + key.slice(2),
    replacement: fileURLToPath(new URL(entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'), coreSourceRoot))
  })).sort((a, b) => b.find.length - a.find.length)

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'discard-options': { file: 'packages/core/src/browser-capture-cli.ts', before: '${JSON.stringify(options)}', after: '{}' },
  'skip-retained-result': { file: 'packages/core/src/browser-capture-cli.ts', before: "if (reference.kind !== 'browser-result-artifact') return report", after: 'return report' },
  'drop-shared-options': { file: 'packages/browser/src/browser-program-owner.ts', before: 'prepareBrowserScreenshot(attached.sendCommand, options, before)', after: 'prepareBrowserScreenshot(attached.sendCommand, {}, before)' },
  'wrong-density': { file: 'packages/browser/src/browser-screenshot-options.ts', before: 'scale: ratio / viewport.deviceScaleFactor', after: 'scale: 1' },
  'wrong-coordinates': { file: 'packages/browser/src/browser-screenshot-options.ts', before: 'x: dip(pageX + clip.x)', after: 'x: pageX + clip.x' },
  'truncate-float-bounds': { file: 'packages/browser/src/browser-screenshot-options.ts', before: 'width: dip(clip.width)', after: 'width: clip.width * zoom' },
  'lose-output': { file: 'packages/core/src/agentmux-cli-commands.ts', before: "match!.command.method === 'browser.capture' ||", after: '' }
}
export default defineConfig({
  resolve: { alias: [
    { find: '@agentmux/native-desktop/image', replacement: resolve(root, 'packages/native-desktop/src/image.ts') },
    ...coreSourceAliases,
    { find: '@agentmux/core', replacement: resolve(root, 'packages/core/src/index.ts') },
    { find: /^@agentmux\/identity(?:\/.*)?$/, replacement: resolve(root, 'packages/identity/src/index.ts') },
    { find: /^@agentmux\/browser\/(.*)$/, replacement: resolve(root, 'packages/browser/src/$1.ts') }
  ] },
  plugins: [{ name: 'capture-actual-source', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('packages/') && !file.startsWith('apps/desktop/')) return
    const m = process.env.BROWSER_CAPTURE_SOURCE_MUTATION
    if (m) assert.ok(mutations[m], 'Known bearing mutation')
    const target = m ? mutations[m]! : undefined
    let code = source
    if (target?.file === file) { assert.equal(source.split(target.before).length, 2); code = source.replace(target.before, target.after) }
    if (process.env.BROWSER_CAPTURE_SOURCE_LOADED) appendFileSync(process.env.BROWSER_CAPTURE_SOURCE_LOADED,
      JSON.stringify({ file, source: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex'), mutated: source !== code }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }],
  test: { include: ['packages/core/test/browser-capture-cli.test.ts', 'apps/desktop/test/browser-screenshot-options.test.ts', 'apps/desktop/test/browser-shared-owner-capture.test.ts'],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
