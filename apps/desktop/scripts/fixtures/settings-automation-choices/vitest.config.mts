import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../settings-recovery-choices/vitest.config.mts'
import { root } from '../settings-resource-library/environment.mjs'

export default defineConfig({ ...base,
  plugins: process.env.AGENTMUX_AUTOMATION_CHOICE_MUTANT ? [{ name: 'automation-choice-owner-mutation', enforce: 'pre', transform(source, id) {
    const file = 'apps/desktop/src/renderer/src/components/settings/AutomationDefaultsSettingsPane.tsx'
    if (id.split('?')[0] !== resolve(root, file)) return
    const before = "onValueChange={value => draft.setField('progressPrompt', value)}"
    if (source.split(before).length !== 2) throw new Error('Expected one default prompt owner')
    const changed = source.replace(before, 'onValueChange={() => {}}')
    if (process.env.AGENTMUX_AUTOMATION_CHOICE_EVIDENCE) appendFileSync(process.env.AGENTMUX_AUTOMATION_CHOICE_EVIDENCE, JSON.stringify({
      mutant: 'progress-prompt', file, count: 1,
      original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(changed).digest('hex')
    }) + '\n')
    return { code: changed, map: null }
  } }] : [],
  test: { ...base.test, include: ['apps/desktop/test/settings-automation-choices.test.tsx', 'apps/desktop/test/session-continuity-settings.test.tsx'] }
})
