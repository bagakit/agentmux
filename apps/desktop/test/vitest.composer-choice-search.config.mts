import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { Alias } from 'vite'
import original from './selection-field.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const tools = 'apps/desktop/src/renderer/src/components/AgentComposerTools.tsx'
const choice = 'packages/client-ui/src/components/SearchChoiceDialog.tsx'
const quote = String.fromCharCode(96)
const mutations = {
  filter: [tools, 'skills.filter(skill => ' + quote + '\u0024{skill.name} \u0024{skill.description} \u0024{skill.source}' + quote + '.toLocaleLowerCase().includes(query))', 'skills'],
  command: [tools, 'commands.filter(command => ' + quote + '\u0024{command.text} \u0024{command.label ?? \'\'} \u0024{command.description}' + quote + '.toLocaleLowerCase().includes(query))', 'commands'],
  insertion: [tools, 'onChooseSkill(skill)', 'undefined'],
  ime: [choice, 'if (isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }', 'if (false) { event.stopPropagation(); return }'],
  reopen: [choice, "if (!open) setQuery('')", "if (false) setQuery('')"],
  stale: [tools, 'if (request === discovery.current) setSkills(next)', 'setSkills(next)'],
  rejection: [tools, 'if (request !== discovery.current) return', 'if (false) return'],
  session: ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', '<AgentComposer key={sessionId}', '<AgentComposer key="shared"'],
  hover: ['packages/client-ui/src/components/HoverDropdownMenu.tsx', 'if (!event.defaultPrevented) menu.hover.current = false\n      }}\n      onPointerDownOutside', 'if (false) menu.hover.current = false\n      }}\n      onPointerDownOutside'],
  trigger: [choice, 'if (open && preview.current) { event.preventDefault(); enterSearch() }', 'if (open && preview.current) event.preventDefault()'],
  disabled: [tools, 'key={command.id ?? command.text} disabled={disabled}', 'key={command.id ?? command.text}']
} as const
export default defineConfig({ ...original, esbuild: { jsx: 'automatic' },
  resolve: { ...original.resolve, conditions: ['browser', 'module', 'development|production'], alias: [
    { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
    ...(original.resolve?.alias as Alias[])
  ] },
  plugins: [{ name: 'composer-choice-actual-source', enforce: 'pre', transform(source, id) {
    const path = relative(repository, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/client-ui/src/')) return
    let code = source
    const name = process.env.AGENTMUX_COMPOSER_CHOICE_MUTANT as keyof typeof mutations | undefined
    if (name) {
      assert.ok(mutations[name], 'Known semantic mutation')
      const [target, needle, replacement] = mutations[name]
      if (path === target) {
        assert.equal(source.split(needle).length - 1, 1, 'Unique loaded source mutation')
        code = source.replace(needle, replacement)
        if (name === 'reopen') {
          const reset = "if (!next) { setQuery(''); focusPending.current = false }"
          assert.equal(code.split(reset).length - 1, 1, 'A controlled close and local close both reset the current query')
          code = code.replace(reset, 'if (!next) focusPending.current = false')
        }
        if (name === 'session') {
          const scope = '<SessionMailbox key={sessionId}'
          assert.equal(code.split(scope).length - 1, 1, 'Original outer and editor scopes are distinct')
          code = code.replace(scope, '<SessionMailbox key="shared"')
        }
      }
    }
    if (name === 'disabled' && path === choice) {
      const guard = 'if (!current.current.open || trigger.props.disabled) return'
      assert.equal(code.split(guard).length - 1, 1, 'Remove disabled eligibility at the real dialog')
      code = code.replace(guard, 'if (!current.current.open) return')
    }
    if (process.env.AGENTMUX_COMPOSER_CHOICE_LOADS) appendFileSync(process.env.AGENTMUX_COMPOSER_CHOICE_LOADS, JSON.stringify({ path, sourceSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex'), mutant: name ?? null, transformed: source !== code }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { ...original.test, include: ['test/composer-choice-search.test.tsx', 'test/composer-skills-cache.test.tsx', 'test/hover-dropdown-menu.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
