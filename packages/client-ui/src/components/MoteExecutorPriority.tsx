import { moteExecutorPriority, type MoteQuickDefaults } from '@agentmux/core/mote-preferences'
import { IconButton } from './IconButton.js'
import { SelectionField } from './SelectionField.js'
import { SemanticIcon } from '../theme/semantic-icon.js'
import '../styles/selection-field.css'
import '../styles/mote-executor-priority.css'

type ExecutorChoice = { id: string; name: string }

const copy = {
  en: {
    title: 'Executor priority', description: 'AgentMux tries each Executor in order when starting a conversation.',
    add: 'Add Executor', up: (name: string) => 'Move ' + name + ' up',
    down: (name: string) => 'Move ' + name + ' down', remove: (name: string) => 'Remove ' + name,
  },
  zh: {
    title: 'Executor 优先级', description: '启动会话时，AgentMux 按此顺序尝试。',
    add: '添加 Executor', up: (name: string) => '上移 ' + name,
    down: (name: string) => '下移 ' + name, remove: (name: string) => '移除 ' + name,
  },
}

export function MoteExecutorPriority({ defaults, choices, onChange, language = 'en' }: {
  defaults: MoteQuickDefaults
  choices: readonly ExecutorChoice[]
  onChange(defaults: MoteQuickDefaults): void
  language?: keyof typeof copy
}) {
  const text = copy[language]
  const order = moteExecutorPriority(defaults)
  const options = choices.filter(option => !order.includes(option.id)).map(({ id, name }) => ({ value: id, label: name }))
  const update = ([executorId, ...fallbackExecutorIds]: readonly string[]) => {
    const { executorId: _previous, fallbackExecutorIds: _fallbacks, ...other } = defaults
    onChange({ ...other, ...(executorId ? { executorId } : {}), ...(fallbackExecutorIds.length ? { fallbackExecutorIds } : {}) })
  }
  const move = (from: number, to: number) => {
    const next = [...order]
    const [id] = next.splice(from, 1)
    next.splice(to, 0, id!)
    update(next)
  }
  return <fieldset className="mote-executor-priority">
    <legend>{text.title}</legend>
    <p>{text.description}</p>
    {order.length > 0 && <ol role="list">{order.map((id, index) => {
      const label = choices.find(choice => choice.id === id)?.name ?? id
      return <li key={id}>
        <span title={label}>{label}</span>
        <div className="mote-executor-priority__actions">
          <IconButton disabled={index === 0} aria-label={text.up(label)} onClick={() => move(index, index - 1)}><SemanticIcon name="navigation.up" size={14} /></IconButton>
          <IconButton disabled={index === order.length - 1} aria-label={text.down(label)} onClick={() => move(index, index + 1)}><SemanticIcon name="navigation.down" size={14} /></IconButton>
          <IconButton aria-label={text.remove(label)} onClick={() => update(order.filter(item => item !== id))}><SemanticIcon name="action.close" size={14} /></IconButton>
        </div>
      </li>
    })}</ol>}
    {options.length > 0 && <SelectionField label={text.add} value={null} options={options}
      missingOptionLabel={text.add} onValueChange={id => update([...order, id])} />}
  </fieldset>
}
