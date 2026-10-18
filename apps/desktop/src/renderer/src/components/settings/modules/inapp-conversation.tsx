import { useMemo } from 'react'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { semanticIconComponent, SemanticIcon } from '@agentmux/client-ui/icons'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { resolveComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import { APP_APPEARANCE_DEFAULT, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../../../shared/contracts'
import type { SettingsModule } from '../settings-catalog'
import '../inapp-conversation-settings.css'

export const inappConversationSettingsModule = {
  id: 'inapp-conversation',
  group: 'conversation-channels',
  title: 'InApp',
  description: 'The app conversation view, shared input preferences and reading references.',
  icon: semanticIconComponent('object.conversations'),
  keywords: 'inapp in-app conversation activity terminal view reading input messages 对话 应用内 阅读 消息',
  searchTargets: [
    { id: 'conversation-view', title: 'Conversation view', keywords: 'activity terminal switch mode', kind: 'info' },
    { id: 'input-preferences', title: 'User Input', keywords: 'layout shortcut input prefixes', kind: 'action' },
    { id: 'appearance-preferences', title: 'Appearance', keywords: 'theme application typography', kind: 'action' },
    { id: 'references', title: 'Keyboard shortcuts and amux Protocols', keywords: 'read-only reference message format', kind: 'action' },
  ],
  savedSummary: () => 'Conversation view and shared preferences',
  Pane({ config, onNavigate }) {
    const host = useClientUiPlatform()
    const platform = useMemo(() => ({ ...host, renderMessageAvatar: () => <SemanticIcon name="object.conversations" size={13} aria-hidden="true" /> }), [host])
    const completion = resolveComposerInputConfig(config.messageToolCompletion)
    const layout = config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT
    const appearance = config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT
    const theme = getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === (config.appearance.themeId ?? DEFAULT_THEME_ID))
    const question = 'Summarize the proposed changes.'
    const answer = 'The input keeps your draft while you switch views. **Review the changes** before sending the next message.'
    return <div className="settings-pane-stack inapp-conversation" data-inapp-conversation-settings>
      <section className="inapp-conversation__intro" data-settings-field="conversation-view">
        <h3>One Session, two views</h3>
        <p className="settings-group-note">Read messages and work in the same Agent Session. Use Show Activity or Show Terminal in its input toolbar to switch that Agent’s view.</p>
        <div className="inapp-conversation__views" aria-label="Conversation view examples">
          <figure className="inapp-conversation__view" data-example-view="activity"><figcaption><SemanticIcon name="object.conversations" size={15} aria-hidden="true" /><strong>Activity</strong><span>Reading example</span></figcaption>
            <div className="inapp-conversation__activity"><ClientUiProvider platform={platform}><ConversationMessage content={question} speaker={{ role: 'human', id: 'inapp-example-human' }} name="You" messageId="inapp-example-question" compact expandedContent detailsOnlyMetadata />
              <ConversationMessage content={answer} speaker={{ role: 'agent', id: 'inapp-example-agent' }} name="Review" messageId="inapp-example-answer" compact expandedContent detailsOnlyMetadata /></ClientUiProvider></div>
          </figure>
          <figure className="inapp-conversation__view" data-example-view="terminal"><figcaption><SemanticIcon name="object.terminal" size={15} aria-hidden="true" /><strong>Terminal</strong><span>Text example</span></figcaption>
            <div className="inapp-conversation__terminal"><p><b>You</b><span>{question}</span></p><p><b>Review</b><span>{answer}</span></p></div>
          </figure>
        </div>
        <p className="inapp-conversation__example-note">Illustrative content, not a live Session. The terminal’s actual display is provided by the Agent CLI.</p>
      </section>
      <section className="inapp-conversation__destination" data-settings-field="input-preferences">
        <div><h3>User Input</h3>
        <p className="settings-group-note">Shared by every view using the same message input.</p>
        <div className="inapp-conversation__saved" data-inapp-input-summary><span>{layout === 'one-line' ? 'One line' : 'Two lines'}</span><span>Commands <kbd>{completion.command ?? 'Off'}</kbd></span><span>Skills <kbd>{completion.skill ?? 'Off'}</kbd></span><span>Agents & files <kbd>{completion.reference ?? 'Off'}</kbd></span></div></div>
        <button type="button" className="small-button" onClick={() => onNavigate('message-tool')}>Open User Input</button>
      </section>
      <section className="inapp-conversation__destination" data-settings-field="appearance-preferences">
        <div><h3>Appearance</h3>
        <p className="settings-group-note">Shared app colors, typography and reading density.</p>
        <div className="inapp-conversation__saved" data-inapp-appearance-summary><span>{theme?.value.name ?? 'Unavailable theme'}</span><span>{appearance[0]!.toUpperCase() + appearance.slice(1)} appearance</span></div></div>
        <button type="button" className="small-button" onClick={() => onNavigate('appearance')}>Open Appearance</button>
      </section>
      <section className="inapp-conversation__references" data-settings-field="references">
        <h3>Reading & controls</h3>
        <p className="settings-group-note">Read the existing keyboard bindings and supported message formats.</p>
        <div className="settings-workflows__inline-action">
          <button type="button" className="small-button" onClick={() => onNavigate('keyboard-shortcuts')}>Open Keyboard shortcuts</button>
          <button type="button" className="small-button" onClick={() => onNavigate('amux-protocols')}>Open amux Protocols</button>
        </div>
      </section>
    </div>
  }
} as const satisfies SettingsModule
