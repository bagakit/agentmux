import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

const ground = 'components/CollaborationMapGround.tsx', css = 'styles/collaboration.css'
const continuity = 'hands each ground level over continuously through both former level thresholds'
const sweep = 'never jumps a level ink across the zoom range and always keeps one full reference grid'
const consumer = 'paints the same handover on the real Map ground through the camera store'
const dots = 'draws both ground layers with one dot and one ink token, each paired with its own spacing'
const scene = 'keeps closed members discless when selected, contour weight by depth, and recede on the Map motion switch'
export const collaborationGroundMutations = [
  { file: ground, name: 'ground-step-ink', before: 'return smooth(ENTER, FULL, screen) * (1 - smooth(FULL * STEP, RETIRE, screen))', after: 'return Number(screen >= ENTER && screen < RETIRE)', assertion: continuity },
  { file: ground, name: 'ground-coarse-never-retires', before: ' * (1 - smooth(FULL * STEP, RETIRE, screen))', after: '', assertion: sweep },
  { file: ground, name: 'ground-major-full-ink', before: 'String(major.ink)', after: "'1'", assertion: consumer },
  { file: css, name: 'ground-major-dot-size', before: 'calc(var(--map-grid-major-ink, 1) * 100%), transparent) 1px, transparent 1.5px)', after: 'calc(var(--map-grid-major-ink, 1) * 100%), transparent) 1.1px, transparent 1.6px)', assertion: dots },
  { file: css, name: 'closed-selected-disc', before: '.collaboration-agent--closed .collaboration-agent__body { background: transparent; }', after: '.collaboration-agent--closed .collaboration-agent__body:not([data-selected=true]) { background: transparent; }', assertion: scene },
  { file: css, name: 'contour-kind-weight', before: '.collaboration-area[data-kind=topic] .collaboration-area__envelope path { stroke-dasharray: 2 3; }', after: '.collaboration-area[data-kind=topic] .collaboration-area__envelope path { stroke-dasharray: 2 3; }\n.collaboration-area[data-kind=category] .collaboration-area__envelope path { stroke-width: 1; }', assertion: scene },
  { file: css, name: 'closed-selected-ring', before: '.collaboration-agent--closed .collaboration-agent__body:not([data-selected=true]) { box-shadow: none; }', after: '.collaboration-agent--closed .collaboration-agent__body { box-shadow: none; }', assertion: scene },
  { file: css, name: 'recede-outside-motion-contract', before: '.collaboration-area__identity, .collaboration-area__name > strong, .collaboration-area__meta, .collaboration-area__meta em, .collaboration-canvas__motion-switch::after) { transition: border-color', after: '.collaboration-area__name > strong, .collaboration-area__meta, .collaboration-area__meta em, .collaboration-canvas__motion-switch::after) { transition: border-color', assertion: scene }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_GROUND_MUTATION
const mutation = collaborationGroundMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown collaboration ground mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ ...shared, cacheDir: '.cache/collaboration-ground', plugins: [...shared.plugins ?? [], {
  name: 'collaboration-ground-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    const applied = mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file
    let code = source
    if (applied) {
      if (code.split(mutation.before).length !== 2) throw Error('Unique ground mutation anchor required')
      code = code.replace(mutation.before, mutation.after); loaded = true
    }
    if (process.env.AGENTMUX_COLLABORATION_GROUND_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_GROUND_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: applied ? selected : null }) + '\n')
    if (source !== code) return { code, map: null }
  }, buildEnd() { if (selected && !loaded) throw Error('The actual ground mutation source must be loaded') }
}], test: { ...shared.test, pool: 'threads', css: { include: [/\/styles\/(?:base|collaboration)\.css/u] }, include: ['apps/desktop/test/collaboration-map-ground.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
