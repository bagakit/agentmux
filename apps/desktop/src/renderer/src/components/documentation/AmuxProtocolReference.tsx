import { AGENTMUX_PROTOCOL_CATALOG, type AgentMuxProtocolCatalogEntry } from '@agentmux/core/amux-protocol'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { useMemo, useRef, useState, type RefObject } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import './amux-protocol-reference.css'

const formTitles = {
  envelope: 'Envelopes',
  prompt: 'Prompts',
  marker: 'Markers',
  frame: 'Frames',
  link: 'Links',
  extension: 'Extensions'
} satisfies Record<AgentMuxProtocolCatalogEntry['form'], string>

/** Examples use the real reader without resolving fictional objects or user identities. */
function ProtocolExamples({ entry }: { entry: AgentMuxProtocolCatalogEntry }) {
  const host = useClientUiPlatform()
  const platform = useMemo(() => ({ ...host,
    renderMessageAvatar: () => <SemanticIcon name="object.document" size={13} aria-hidden="true" />,
    renderObjectLink: ({ uri, label }: { uri: string; label?: string }) => <code title={uri}>{label ?? uri}</code>
  }), [host])
  return <ClientUiProvider platform={platform}>
    {entry.examples.map((example, index) => <section key={index} className="amux-protocols__example" aria-label={example.label}>
      <h4>{example.label}</h4>
      <div className="amux-protocols__comparison">
        <div className="amux-protocols__wire"><span className="amux-protocols__preview-label">Original wire</span><pre>{example.wire}</pre></div>
        <div className="amux-protocols__rendered"><span className="amux-protocols__preview-label">Rendered message</span><div className="amux-protocols__preview" data-protocol-example={entry.id}>
          <ConversationMessage content={example.wire} speaker={{ role: 'human', id: 'protocol-example' }} name="Example input"
            messageId={`protocol-example:${entry.id}:${index}`} compact expandedContent />
        </div></div>
      </div>
    </section>)}
  </ClientUiProvider>
}

function PromptExamples({ entry }: { entry: AgentMuxProtocolCatalogEntry }) {
  return entry.examples.map((example, index) => <section key={index} className="amux-protocols__example">
    <h4>{example.label}</h4>
    <div className="amux-protocols__source" data-protocol-example={entry.id}><pre>{example.wire}</pre></div>
  </section>)
}

function ProtocolRow({ entry, active, rowRef }: { entry: AgentMuxProtocolCatalogEntry; active: boolean; rowRef?: RefObject<HTMLDetailsElement | null> | undefined }) {
  const [open, setOpen] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  return <details ref={rowRef} className="amux-protocols__row" data-protocol-entry={entry.id} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><SemanticIcon name="navigation.disclosure" size={13} aria-hidden="true" /><strong>{entry.title}</strong></summary>
    {open && active ? <div className="amux-protocols__body"><p className="amux-protocols__description">{entry.description}</p>{entry.form === 'prompt' ? <PromptExamples entry={entry} /> : <ProtocolExamples entry={entry} />}
      <details className="amux-protocols__templates" open={showTemplates} onToggle={event => setShowTemplates(event.currentTarget.open)}>
        <summary>Templates</summary>
        {showTemplates ? entry.templates.map(template => <section key={template.name} className="amux-protocols__example">
          <h4>{template.name}</h4><div className="amux-protocols__source"><pre>{template.text}</pre></div>
        </section>) : null}
      </details></div> : null}
  </details>
}

export function AmuxProtocolReference({ active }: { active: boolean }) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null), firstExample = useRef<HTMLDetailsElement>(null)
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? AGENTMUX_PROTOCOL_CATALOG.filter(entry => `${entry.id} ${entry.title} ${entry.description} ${entry.form} ${entry.examples.map(example => `${example.label} ${example.wire}`).join(' ')}`.toLowerCase().includes(normalized) ||
      entry.templates.some(template => template.name.includes(normalized) || template.text.toLowerCase().includes(normalized))) : AGENTMUX_PROTOCOL_CATALOG
  }, [query])
  const groups = useMemo(() => {
    const byForm = new Map<string, AgentMuxProtocolCatalogEntry[]>()
    for (const entry of visible) {
      const entries = byForm.get(entry.form)
      if (entries) entries.push(entry)
      else byForm.set(entry.form, [entry])
    }
    return Object.entries(formTitles).flatMap(([form, title]) => {
      const entries = byForm.get(form)
      return entries ? [{ form, title, entries }] : []
    })
  }, [visible])
  function openFirstExample() {
    if (!firstExample.current) return
    firstExample.current.open = true
    firstExample.current.querySelector('summary')?.focus()
  }
  return <section className="amux-protocols" aria-label="amux protocol reference">
    <div className="amux-protocols__toolbar">
      <label className="amux-protocols__search"><SemanticIcon name="action.search" size={15} aria-hidden="true" /><TextInput ref={search} data-documentation-search aria-label="Search amux Protocols" placeholder="Find a format or template…" value={query} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" className="icon-button" aria-label="Clear documentation search" onClick={() => { setQuery(''); search.current?.focus() }}><SemanticIcon name="action.clear" size={13} /></button> : null}</label>
      <span className="amux-protocols__count" role="status">{visible.length === AGENTMUX_PROTOCOL_CATALOG.length ? `${visible.length} entries` : `${visible.length} of ${AGENTMUX_PROTOCOL_CATALOG.length} entries`}</span>
      {visible.length ? <Button type="button" onClick={openFirstExample}>View first example</Button> : null}
    </div>
    <p className="amux-protocols__read-only">Read-only examples do not contact Agents, open links or execute protocol hints.</p>
    <div className="amux-protocols__index">{groups.length ? <div className="amux-protocols__groups">{groups.map(({ form, title, entries }, groupIndex) =>
      <section key={form} data-protocol-form={form} aria-labelledby={`amux-protocol-form-${form}`}>
        <h3 id={`amux-protocol-form-${form}`}>{title}</h3>
        <div className="amux-protocols__list">{entries.map((entry, index) =>
          <ProtocolRow key={entry.id} entry={entry} active={active} rowRef={groupIndex === 0 && index === 0 ? firstExample : undefined} />)}</div>
      </section>)}</div>
      : <p className="amux-protocols__empty">No entries match “{query}”. Try a name, format or template.</p>}</div>
  </section>
}
