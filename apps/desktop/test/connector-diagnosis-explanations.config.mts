import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.DIAGNOSIS_UI_MUTANT
const owner = 'apps/desktop/src/renderer/src/lib/connector-group-status.ts'
const variants = {
  cause: ['const sourceCause = connectorSourceExplanation(out?.sourceObservation)', 'const sourceCause = connectorSourceExplanation(undefined)'],
  scope: ["// This flag belongs to the bot's cross-group intake, not this group's last input.", "value = 'Inputs need checking'; incomingProblem = 'intake-unconfirmed'"]
} as const
if (mutation && !(mutation in variants)) throw Error('Unknown diagnosis UI mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/connector-diagnosis-explanations'), plugins: [...base.plugins!, {
  name: 'original-diagnosis-ui-loaded', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^(apps\/(desktop|host)|packages\/(core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(file)) return
    let loaded = source
    if (mutation && file === owner) { const [before, after] = variants[mutation as keyof typeof variants]; if (source.split(before).length !== 2) throw Error('Diagnosis mutation anchor missing or ambiguous'); loaded = source.replace(before, after) }
    const marker = process.env.DIAGNOSIS_UI_LOADED
    if (!marker) return loaded === source ? undefined : { code: loaded, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex'), row = JSON.stringify({ file, source: hash(source), loaded: hash(loaded), mutation: source === loaded ? null : mutation }) + '\n'
    return { code: "import {appendFileSync as __diagnosisUiLoaded}from'node:fs';__diagnosisUiLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(row) + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-diagnosis-explanations.test.tsx', 'apps/desktop/test/connector-input-recovery.test.tsx'], testNamePattern: undefined, passWithNoTests: false, fileParallelism: false, hookTimeout: 20_000, testTimeout: 35_000 } })
