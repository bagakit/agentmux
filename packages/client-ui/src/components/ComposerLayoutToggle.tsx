import { Expand, Wrench, Minimize } from 'lucide-react'
export type ComposerToolPhase = 'collapsed' | 'current' | 'expanded'
export function nextToolDockPhase(phase: ComposerToolPhase): ComposerToolPhase {
  return phase === 'collapsed' ? 'current' : phase === 'current' ? 'expanded' : 'collapsed'
}
export function ComposerLayoutToggle({ phase, onChange }: { phase: ComposerToolPhase; onChange(phase: ComposerToolPhase): void }) {
  const label = phase === 'collapsed' ? 'Show the message tool row' : phase === 'current' ? 'Grow the input box for long text' : 'Collapse the composer to one line'
  const Icon = phase === 'collapsed' ? Wrench : phase === 'current' ? Expand : Minimize
  return <button type="button" className="composer-tool composer-tool--mode" aria-label={label} title={label} onClick={() => onChange(nextToolDockPhase(phase))}><Icon size={14} /></button>
}
