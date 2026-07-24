import { Play, RadioTower, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'

const AGENTS = [
  { id: 'codex', label: 'Codex', accent: 'green' },
  { id: 'claude', label: 'Claude', accent: 'orange' },
  { id: 'hermes', label: 'Hermes', accent: 'violet' },
  { id: 'pi', label: 'Pi', accent: 'blue' }
] as const

export function LaunchAgent() {
  const [agentId, setAgentId] = useState('codex')
  const [prompt, setPrompt] = useState('')
  const [launching, setLaunching] = useState(false)
  const launch = useAppStore((state) => state.launch)
  const config = useAppStore((state) => state.config)
  const workspaceId = useAppStore((state) => state.activeWorkspaceId)
  const workspace = config?.workspaces.find((item) => item.id === workspaceId)

  async function start(): Promise<void> {
    setLaunching(true)
    try {
      await launch(agentId, prompt)
    } finally {
      setLaunching(false)
    }
  }

  return (
    <section className="launch-card">
      <div className="launch-card__icon"><Sparkles size={22} /></div>
      <div>
        <div className="eyebrow">New tmux session</div>
        <h2>Put an agent to work</h2>
        <p>The provider owns CLI details. This workspace owns context and files.</p>
      </div>
      <div className="agent-picks">
        {AGENTS.map((agent) => (
          <button
            key={agent.id}
            className={`agent-pick agent-pick--${agent.accent} ${agent.id === agentId ? 'agent-pick--selected' : ''}`}
            onClick={() => setAgentId(agent.id)}
          >
            <span>{agent.label.slice(0, 1)}</span>{agent.label}
          </button>
        ))}
      </div>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the outcome. You can follow up after launch."
        rows={4}
      />
      <div className="launch-card__footer">
        <span>{workspace?.hostId !== 'local' ? <RadioTower size={13} /> : null}{workspace?.name ?? 'No workspace'}</span>
        <button className="primary-button" disabled={!workspace || launching} onClick={() => void start()}>
          <Play size={14} /> {launching ? 'Launching…' : 'Launch agent'}
        </button>
      </div>
    </section>
  )
}
