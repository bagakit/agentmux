import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { AgentMarkdown } from '../../../src/components/AgentMarkdown.js'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const source = '  const options = {\n    mode: "review",\n    preserve: ["indentation", "line endings", "literal <tag>"],\n    description: "A deliberately long line keeps horizontal code scrolling local to the source, while the language and copy action stay in view."\n  };\n\n'
const attempts: Array<{ text: string; resolve(value: boolean): void; error(error: unknown): void }> = []
const platform: ClientUiPlatform = { copyText: (text, error) => new Promise(resolve => attempts.push({ text, error, resolve })),
  overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
Object.assign(window, { codeCopyFixture: { attempts, source } })
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Code block copying</strong><span>Actual shared components · controlled clipboard receipts</span>
      <button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="message"><ConversationMessage messageId="code-message" speaker={{ role: 'agent', id: 'code-agent' }} name="Assistant" status="complete"
      content={'Review the configuration before applying it. Copy either snippet independently.\n\n```typescript\n' + source + '\n```\n\nThe language label and feedback stay outside the source.\n\n```a-long-language-label-for-narrow-region-inspection\n  preserve_every_character()\n```'} /></section>
    <section id="document"><h2>Markdown document</h2><AgentMarkdown documentMode content={'```json\n{ "mode": "review", "apply": false }\n```'} /></section>
    <section id="inert"><h2>Read-only preview and diagram source</h2><AgentMarkdown readOnly content={'```js\nconst preview = "read only";\n```'} /><AgentMarkdown content={'```mermaid\ngraph LR; Source-->View\n```'} /></section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
