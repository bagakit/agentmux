import { SemanticIcon } from '../theme/icons.js'
export type ComposerToolPhase = 'collapsed' | 'current' | 'expanded'
export function nextToolDockPhase(phase: ComposerToolPhase): ComposerToolPhase {
  return phase === 'collapsed' ? 'current' : phase === 'current' ? 'expanded' : 'collapsed'
}
export function ComposerLayoutToggle({ phase, onChange }: { phase: ComposerToolPhase; onChange(phase: ComposerToolPhase): void }) {
  const label = phase === 'collapsed' ? 'Show the message tool row' : phase === 'current' ? 'Grow the input box for long text' : 'Collapse the composer to one line'
  const icon = phase === 'collapsed' ? 'object.tools' : phase === 'current' ? 'layout.expand' : 'layout.collapse'
  return <button type="button" className="composer-tool composer-tool--mode" aria-label={label} title={label} onClick={() => onChange(nextToolDockPhase(phase))}><SemanticIcon name={icon} size={14} /></button>
}
