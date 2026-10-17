import { semanticIconComponent } from '@agentmux/client-ui/icons'
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
  Pane({ onNavigate }) {
    return <div className="settings-pane-stack inapp-conversation" data-inapp-conversation-settings>
      <section className="inapp-conversation__intro" data-settings-field="conversation-view">
        <h3>One Session, two views</h3>
        <p className="settings-group-note">Read messages and work in the same Agent Session. Use Show Activity or Show Terminal in its input toolbar to switch that Agent’s view.</p>
      </section>
      <section className="inapp-conversation__destination" data-settings-field="input-preferences">
        <div><h3>User Input</h3>
        <p className="settings-group-note">Choose input layout, shortcut prefixes and prompt suggestions. These preferences are shared with other views using the same input.</p></div>
        <button type="button" className="small-button" onClick={() => onNavigate('message-tool')}>Open User Input</button>
      </section>
      <section className="inapp-conversation__destination" data-settings-field="appearance-preferences">
        <div><h3>Appearance</h3>
        <p className="settings-group-note">Set the shared app theme, typography and reading density.</p></div>
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
