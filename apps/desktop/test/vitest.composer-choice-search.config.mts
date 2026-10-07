import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from './selection-field.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const tools = 'apps/desktop/src/renderer/src/components/AgentComposerTools.tsx'
const quote = String.fromCharCode(96)
const mutations = {
  filter: [tools, 'skills.filter(skill => ' + quote + '\u0024{skill.name} \u0024{skill.description} \u0024{skill.source}' + quote + '.toLocaleLowerCase().includes(query))', 'skills'],
  command: [tools, 'commands.filter(command => ' + quote + '\u0024{command.text} \u0024{command.description}' + quote + '.toLocaleLowerCase().includes(query))', 'commands'],
  insertion: [tools, 'onChooseSkill(skill)', 'undefined'],
  ime: [tools, 'if (isImeOwnedKeyboardEvent(event)) event.stopPropagation()', 'if (false) event.stopPropagation()'],
  reopen: [tools, "if (!open) setQuery('')", "if (false) setQuery('')"],
  stale: [tools, 'if (request === discovery.current) setSkills(next)', 'setSkills(next)'],
  rejection: [tools, 'if (request !== discovery.current) return', 'if (false) return'],
  session: ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', '<AgentComposer key={sessionId}', '<AgentComposer key="shared"'],
  hover: ['apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx', 'if (!event.defaultPrevented) menu.hover.current = false\n      }}\n      onPointerDownOutside', 'if (false) menu.hover.current = false\n      }}\n      onPointerDownOutside'],
  trigger: ['apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx', 'menu.hover.current = false\n          menu.content.current?.focus()', 'void 0'],
  disabled: [tools, 'key={command.text} disabled={disabled}', 'key={command.text}']
} as const
export default defineConfig({ ...original, esbuild: { jsx: 'automatic' },
  resolve: { ...original.resolve, conditions: ['browser', 'module', 'development|production'] },
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
        if (name === 'session') {
          const scope = '<SessionMailbox key={sessionId}'
          assert.equal(code.split(scope).length - 1, 1, 'Original outer and editor scopes are distinct')
          code = code.replace(scope, '<SessionMailbox key="shared"')
        }
      }
    }
    if (process.env.AGENTMUX_COMPOSER_CHOICE_LOADS) appendFileSync(process.env.AGENTMUX_COMPOSER_CHOICE_LOADS, JSON.stringify({ path, sourceSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex'), mutant: name ?? null, transformed: source !== code }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { ...original.test, include: ['test/composer-choice-search.test.tsx', 'test/composer-skills-cache.test.tsx', 'test/hover-dropdown-menu.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
