import '../../styles/bot-setup-guide.css'

export type BotSetupGuideStage = 'prepare' | 'scan' | 'account' | 'create' | 'connect' | 'bind' | 'ready' | 'attention'
const stepForStage: Record<BotSetupGuideStage, 1 | 2 | 3 | 4> = {
  prepare: 1, scan: 2, account: 2, create: 3, connect: 4, bind: 4, ready: 4, attention: 2
}

/** Numbered presentation of caller-owned facts. No timer, permission or operation state lives here. */
export function BotSetupGuide({ stage, title, description, currentStep, currentStatus, confirmedSteps = [], existingApplication = false }: {
  stage: BotSetupGuideStage; title?: string | undefined; description?: string | undefined
  currentStep?: 1 | 2 | 3 | 4 | null | undefined; currentStatus?: string | undefined; confirmedSteps?: readonly number[] | undefined; existingApplication?: boolean | undefined
}) {
  const current = currentStep === undefined ? stepForStage[stage] : currentStep
  const labels = ['Identity', 'Sign in', existingApplication ? 'Saved application' : 'Create bot', 'Configure & publish']
  return <nav className="bot-setup-guide" aria-label="Bot setup progress" data-bot-setup-guide={stage}>
    <ol>{labels.map((label, index) => {
      const number = index + 1, recordedApplication = existingApplication && number === 3
      const state = number === current ? stage === 'attention' ? 'attention' : 'current' : confirmedSteps.includes(number) || recordedApplication ? 'recorded' : 'upcoming'
      return <li key={number} data-step={number} data-state={state} aria-current={number === current ? 'step' : undefined}>
        <span className="bot-setup-guide__number" aria-hidden="true">{state === 'recorded' ? '✓' : number}</span>
        <span><strong>{label}</strong><small>{number === current ? currentStatus ?? (stage === 'attention' ? 'Needs attention' : 'Current step') : recordedApplication ? 'Already saved' : confirmedSteps.includes(number) ? 'Confirmed' : current !== null && number > current ? 'Not started' : 'Not confirmed'}</small></span>
      </li>
    })}</ol>
    {title || description ? <p>{title ? <strong>{title} </strong> : null}{description}</p> : null}
  </nav>
}
