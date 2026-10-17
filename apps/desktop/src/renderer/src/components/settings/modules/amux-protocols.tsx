import { AGENTMUX_PROTOCOL_CATALOG, type AgentMuxProtocolCatalogEntry } from '@agentmux/core/agent-message-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { useMemo, useState } from 'react'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-amux-protocols.css'

/** Examples use the real message reader without resolving fictional objects or user identities. */
function ProtocolExamples({ entry }: { entry: AgentMuxProtocolCatalogEntry }) {
  const host = useClientUiPlatform()
  const platform = useMemo(() => ({ ...host,
    renderMessageAvatar: () => <SemanticIcon name="object.document" size={13} aria-hidden="true" />,
    renderObjectLink: ({ uri, label }: { uri: string; label?: string }) => <code title={uri}>{label ?? uri}</code>
  }), [host])
  return <ClientUiProvider platform={platform}>
    {entry.examples.map((example, index) => <section key={index} className="amux-protocols__example" aria-label={example.label}>
      <h4>{example.label}</h4>
      <div className="amux-protocols__preview" data-protocol-example={entry.id}>
        <ConversationMessage content={example.wire} speaker={{ role: 'human', id: 'protocol-example' }} name="Example input"
          messageId={`protocol-example:${entry.id}:${index}`} compact expandedContent />
      </div>
    </section>)}
  </ClientUiProvider>
}

function ProtocolRow({ entry, active }: { entry: AgentMuxProtocolCatalogEntry; active: boolean }) {
  const [open, setOpen] = useState(false)
  return <details className="amux-protocols__row" data-settings-field={entry.id}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <SemanticIcon name="navigation.disclosure" size={13} aria-hidden="true" />
      <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
      <code>{entry.form}</code>
    </summary>
    {open && active ? <div className="amux-protocols__body">
      <h4>Syntax</h4><pre className="amux-protocols__syntax">{entry.syntax}</pre>
      <ProtocolExamples entry={entry} />
    </div> : null}
  </details>
}

function AmuxProtocolsPane({ active }: { active: boolean }) {
  return <div className="settings-pane-stack amux-protocols" aria-label="amux protocol reference">
    <p className="settings-group-note">Readable formats included in this app version. Examples use the shared message reader; they do not contact Agents, open links or execute protocol hints.</p>
    <div className="amux-protocols__list">{AGENTMUX_PROTOCOL_CATALOG.map(entry => <ProtocolRow key={entry.id} entry={entry} active={active} />)}</div>
  </div>
}

export const amuxProtocolsSettingsModule = {
  id: 'amux-protocols',
  group: 'message-tool',
  title: 'amux Protocols',
  description: 'Readable formats, original wire examples, and shared message cards.',
  icon: semanticIconComponent('object.document'),
  keywords: 'amux protocol protocols reference wire declaration envelope marker sharing links format card 协议 格式 声明 卡片 参考',
  searchTargets: AGENTMUX_PROTOCOL_CATALOG.map(entry => ({ id: entry.id, title: entry.title, description: entry.description,
    keywords: `${entry.id} ${entry.form} ${entry.syntax}`, kind: 'info' as const })),
  savedSummary: () => `${AGENTMUX_PROTOCOL_CATALOG.length} read-only formats`,
  Pane: AmuxProtocolsPane
} as const satisfies SettingsModule
