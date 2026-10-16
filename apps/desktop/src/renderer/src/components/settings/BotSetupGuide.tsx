import { useEffect, useRef, useState } from 'react'
import '../../styles/bot-setup-guide.css'

export type BotSetupGuideStage = 'prepare' | 'scan' | 'account' | 'create' | 'connect' | 'bind' | 'ready' | 'attention'

const copy: Record<BotSetupGuideStage, { title: string; description: string }> = {
  prepare: { title: 'Make it yours', description: 'Choose the identity people will see in their conversations.' },
  scan: { title: 'Continue on your phone', description: 'Scan the sign-in code and confirm with your management account.' },
  account: { title: 'Choose the right account', description: 'Review the account and enterprise before continuing.' },
  create: { title: 'Create this identity', description: 'Your chosen name and image become one new bot.' },
  connect: { title: 'Bring conversations together', description: 'Review each setting, then confirm the changes you want to make.' },
  bind: { title: 'Give your Agent an identity', description: 'Choose which saved bot this Agent will use by default.' },
  ready: { title: 'Keep going with this bot', description: 'Your bot is saved here. Continue with its conversation setup.' },
  attention: { title: 'Stay with the original setup', description: 'Check the saved result to find the next available action.' }
}

function BotMark({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <path d="M0 6V0M-4 0h8" className="bot-setup-guide__ink" />
    <rect x="-25" y="8" width="50" height="38" rx="13" className="bot-setup-guide__bot" />
    <path d="M-14 24v3m28-3v3M-7 36H7" className="bot-setup-guide__ink" />
    <path d="M-30 23v10m60-10v10" className="bot-setup-guide__outline" />
  </g>
}

function WindowFrame() {
  return <>
    <rect x="36" y="25" width="208" height="116" rx="12" className="bot-setup-guide__panel" />
    <path d="M36 47h208" className="bot-setup-guide__outline" />
    <circle cx="49" cy="36" r="2" className="bot-setup-guide__muted" />
    <circle cx="57" cy="36" r="2" className="bot-setup-guide__muted" />
    <path d="M70 36h35" className="bot-setup-guide__outline" />
  </>
}

function Scene({ stage }: { stage: BotSetupGuideStage }) {
  if (stage === 'scan') return <>
    <rect x="29" y="47" width="159" height="94" rx="10" className="bot-setup-guide__panel" />
    <path d="M29 65h159m-146-9h27" className="bot-setup-guide__outline" />
    <path d="M89 82H77v12m40-12h12v12m0 12v12h-12m-40-12v12h12" className="bot-setup-guide__ink" />
    <g className="bot-setup-guide__phone-motion">
      <rect x="179" y="23" width="65" height="119" rx="13" className="bot-setup-guide__phone" />
      <path d="M203 33h17m-17 99h17" className="bot-setup-guide__outline" />
      <path d="M197 58h-6v10m35-10h6v10m0 23v10h-6m-35-10v10h6" className="bot-setup-guide__ink" />
      <path d="M195 80h33" className="bot-setup-guide__scan-motion bot-setup-guide__ink" />
    </g>
    <path d="M144 94h20m-5-5 5 5-5 5" className="bot-setup-guide__outline" />
  </>
  if (stage === 'account') return <>
    <WindowFrame />
    <circle cx="88" cy="84" r="13" className="bot-setup-guide__accent-fill" />
    <path d="M65 122v-4a23 23 0 0 1 46 0v4" className="bot-setup-guide__ink" />
    <path d="M133 77h77m-77 12h54m-54 22h77m-77 10h38" className="bot-setup-guide__outline" />
    <path d="M133 77h35" className="bot-setup-guide__account-motion bot-setup-guide__ink" />
  </>
  if (stage === 'connect') return <>
    <rect x="27" y="44" width="93" height="98" rx="13" className="bot-setup-guide__panel" />
    <BotMark x={73} y={65} />
    <path d="M120 92h35" className="bot-setup-guide__outline" />
    <circle cx="129" cy="92" r="3" className="bot-setup-guide__packet-motion bot-setup-guide__accent-fill" />
    <rect x="155" y="27" width="98" height="115" rx="12" className="bot-setup-guide__panel" />
    {[55, 83, 111].map((y, i) => <g key={y}>
      <path d={`M169 ${y}h26`} className="bot-setup-guide__outline" />
      <rect x="209" y={y - 5} width="27" height="10" rx="5" className="bot-setup-guide__control" />
      <circle cx={i === 1 ? 216 : 229} cy={y} r="3" className="bot-setup-guide__muted" />
    </g>)}
  </>
  if (stage === 'bind') return <>
    <rect x="30" y="38" width="91" height="103" rx="12" className="bot-setup-guide__panel" />
    <BotMark x={75} y={60} />
    <path d="M121 91h37m-6-5 6 5-6 5" className="bot-setup-guide__ink" />
    <rect x="166" y="38" width="84" height="103" rx="12" className="bot-setup-guide__panel" />
    <path d="m190 70 9 8-9 8m17 0h15m-33 28h34" className="bot-setup-guide__ink" />
    <circle cx="139" cy="91" r="3" className="bot-setup-guide__bind-motion bot-setup-guide__accent-fill" />
  </>
  if (stage === 'attention') return <>
    <WindowFrame />
    <path d="M90 70h47l13 13v40H90zM137 70v13h13m-46 13h31m-31 10h21" className="bot-setup-guide__outline" />
    <path d="M180 83a22 22 0 1 1-7 28m7-28h-12m12 0v12" className="bot-setup-guide__ink" />
  </>
  return <>
    <WindowFrame />
    <g className={stage === 'ready' ? undefined : 'bot-setup-guide__identity-motion'}><BotMark x={111} y={62} /></g>
    <path d="M157 81h59m-59 11h40m-40 20h53" className="bot-setup-guide__outline" />
    {stage === 'create' ? <g className="bot-setup-guide__accent-motion"><circle cx="229" cy="48" r="14" className="bot-setup-guide__badge" /><path d="M223 48h12m-6-6v12" className="bot-setup-guide__ink" /></g> : null}
    {stage === 'ready' ? <path d="M209 117h29m-7-7 7 7-7 7" className="bot-setup-guide__ink" /> : null}
  </>
}

/** A visual explanation only. Callers retain all progress, permission and action facts. */
export function BotSetupGuide({ stage, title, description }: { stage: BotSetupGuideStage; title?: string | undefined; description?: string | undefined }) {
  const root = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let inView = typeof IntersectionObserver === 'undefined'
    const sync = () => setVisible(inView && !document.hidden)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting); sync()
    })
    if (root.current) observer?.observe(root.current)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', sync) }
  }, [])
  return <figure ref={root} className="bot-setup-guide" data-bot-setup-guide={stage} data-motion={visible ? 'on' : 'off'}>
    <svg viewBox="0 0 280 168" fill="none" aria-hidden="true" focusable="false">
      <path d="M22 149h236" className="bot-setup-guide__ground" />
      <Scene stage={stage} />
    </svg>
    <figcaption><span>{title ?? copy[stage].title}</span><p>{description ?? copy[stage].description}</p></figcaption>
  </figure>
}
