import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/settings-overview/vitest.config.mts'

const names = ['NotebookSelector', 'SpaceCreateMenu', 'TopicCategoryMenu', 'TopicContextMenu']
export default defineConfig({
  ...source,
  plugins: [{
    name: 'isolated-hover-consumer-counterexample', enforce: 'pre',
    transform(code, id) {
      if (process.env.AGENTMUX_MENU_MUTATION === 'raw-consumers' && names.some(name => id.endsWith('/' + name + '.tsx'))) {
        const from = "import * as DropdownMenu from './HoverDropdownMenu'"
        if (!code.includes(from)) throw new Error('Actual hover consumer mutation anchor is missing: ' + id)
        return code.replace(from, "import * as DropdownMenu from '@radix-ui/react-dropdown-menu'")
      }
      if (process.env.AGENTMUX_MENU_MUTATION === 'survey-closed' && id.endsWith('/GlobalSurveySurface.tsx')) {
        const from = '<SurveyPanelChoices mode="button" open visible='
        if (!code.includes(from)) throw new Error('Actual Survey disclosure mutation anchor is missing')
        return code.replace(from, '<SurveyPanelChoices mode="button" open={false} visible=')
      }
    }
  }],
  test: {
    ...source.test,
    include: ['apps/desktop/test/hover-option-consumers.test.tsx', 'apps/desktop/test/hover-dropdown-menu.test.tsx',
      'apps/desktop/test/space-open-folder.test.tsx', 'apps/desktop/test/topic-move-dialog.test.tsx',
      'apps/desktop/test/recall-surface.test.tsx', 'apps/desktop/test/survey-surface.test.tsx']
  }
})
