import { defineConfig } from 'vitest/config'
import original from '../vitest.config'
const mutation = process.env.AGENT_SQUARE_FACE_MUTANT
const changes = {
  slot: ['/theme/icon-catalog.ts', "'space.agent': { label: 'Agent space icon', glyph: 'agent-unit' }", "'space.agent': { label: 'Agent space icon', glyph: 'bot' }"],
  fill: ['/theme/icon-authored.ts', '"fill":"currentColor", "stroke":"none", "fill-rule":"evenodd"', '"fill":"none", "stroke":"none", "fill-rule":"evenodd"'],
  theme: ['/theme/builtin-retro.ts', '  icons: {', "  icons: {\n    'object.agent': { kind: 'glyph', glyph: 'bot' },"]
} as const
if (mutation && !Object.hasOwn(changes, mutation)) throw Error('Unknown square face mutation')
export default defineConfig({ ...original,
  plugins: [{ name: 'agent-square-face-actual-source', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const [suffix, before, after] = changes[mutation as keyof typeof changes]
    if (!id.split('?')[0]!.endsWith(suffix)) return
    if (source.split(before).length !== 2) throw Error('Expected unique production mutation anchor')
    const changed = source.replace(before, after)
    if (changed === source) throw Error('Production mutation was not applied')
    console.log('AGENT_SQUARE_FACE_MUTANT_LOADED ' + mutation)
    return { code: changed, map: null }
  } }],
  test: { ...original.test, include: ['packages/client-ui/test/agent-square-face.test.tsx'], passWithNoTests: false }
})
