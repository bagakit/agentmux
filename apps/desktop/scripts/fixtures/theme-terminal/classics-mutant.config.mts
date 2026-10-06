import { defineConfig } from 'vitest/config'
import base from './vitest.config.mts'
const mutant = process.env.TERMINAL_CLASSIC_MUTANT
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'classic-production-counterfactual', enforce: 'pre', transform(code, id) {
  let target: string | undefined, replacement = ''
  if (mutant === 'ansi' && id.endsWith('/shared/terminal-palettes.ts')) { target = "blue: '#bd93f9'"; replacement = "blue: '#000000'" }
  if (mutant === 'native' && id.endsWith('/lib/terminal-theme.ts')) { target = 'return definition.theme'; replacement = "return terminalPalette('graphite')" }
  if (mutant === 'watch' && id.endsWith('/main/theme-observation.ts')) { target = 'terminalPalette(config.appearance.terminalTheme)'; replacement = "terminalPalette('graphite')" }
  if (target) { if (code.split(target).length !== 2) throw Error('Counterfactual edge not unique: '+target); return {code: code.replace(target,replacement),map:null} }
} }], test: { ...base.test, include: ['apps/desktop/test/terminal-classics.test.ts'] } })
