import type { ComponentProps, ReactNode } from 'react'
import { BrandIcon } from '@agentmux/client-ui/components/BrandIcon'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { MobileConnection } from '../conversation/use-hosted-conversation'
import './connection.css'

const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeObjectConnectionIcon = semanticIconComponent('object.connection')
const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')

type StepState = 'done' | 'current' | 'pending' | 'attention' | 'unknown'
type AppIcon = ComponentProps<typeof BrandIcon>['icon']
const STEPS = ['在 Mac 的 Phone & Devices 中复制连接链接', '用这台手机打开链接，两台设备连同一 Wi-Fi', '连上 Mac'] as const

/** Progress reads only the typed connection state and pairing fact; the message is shown, never parsed. */
function connectProgress(connection: MobileConnection): StepState[] {
  if (connection.paired === false) return ['current', 'pending', 'pending']
  const linked: StepState = connection.paired ? 'done' : 'unknown'
  const reach: StepState = connection.state === 'connected' ? 'done' : connection.state === 'connecting' ? 'current' : 'attention'
  return [linked, linked, reach]
}
const connectTitle = (connection: MobileConnection) => connection.paired === false ? '连接你的 Mac'
  : connection.state === 'connecting' ? '正在连接 Mac' : connection.state === 'disconnected' ? '连接中断'
    : connection.state === 'connected' ? '已连接 Mac' : '连接需要处理'

function StepMark({ state, index }: { state: StepState; index: number }) {
  return <span className="mobile-connect-step__mark" aria-hidden="true">
    {state === 'done' ? <ThemeStatusCompletedIcon size={14} /> : state === 'attention' ? <ThemeStatusWarningIcon size={14} />
      : state === 'unknown' ? <ThemeStatusUnknownIcon size={14} /> : state === 'current' && index === 2 ? <ThemeStatusLoadingIcon size={14} /> : index + 1}
  </span>
}
const stepStatus: Record<StepState, string> = { done: '已完成', current: '进行中', pending: '未开始', attention: '需要处理', unknown: '未确认' }

export function MobileConnectPage({ connection, appIcon, panel, gatewayEndpoint, onDetails }: {
  connection: MobileConnection; appIcon?: AppIcon; panel?: ReactNode; gatewayEndpoint?: string; onDetails(): void
}) {
  const progress = connectProgress(connection)
  const active = progress.findIndex(state => state === 'current' || state === 'attention')
  return <section className="mobile-connect-page" data-connect-state={connection.paired === false ? 'unpaired' : connection.state}>
    <BrandIcon icon={appIcon} className="mobile-connect-dragon" size={72} alt="AgentMux" />
    <h1>{gatewayEndpoint ? '连接此设备' : connectTitle(connection)}</h1>
    {gatewayEndpoint ? <p className="mobile-connect-gateway">通过网关 <bdi>{gatewayEndpoint}</bdi></p> : <ol className="mobile-connect-steps" aria-label="接入进度">
      {STEPS.map((label, index) => <li key={label} className="mobile-connect-step" data-step-state={progress[index]} aria-current={index === active ? 'step' : undefined}>
        <StepMark state={progress[index]!} index={index} />
        <span className="mobile-connect-step__text"><span>{label}<span className="mobile-visually-hidden">，{stepStatus[progress[index]!]}</span></span>
          {index === active && connection.paired !== false && connection.message ? <small>{connection.message}</small> : null}</span>
      </li>)}
    </ol>}
    {panel ? <div className="mobile-connect-panel">{panel}</div> : null}
    <button type="button" className="mobile-secondary mobile-connect-details" onClick={onDetails}><ThemeObjectConnectionIcon size={16} />连接详情</button>
  </section>
}

/** The drawer's first group: which Mac this phone uses and whether it is reached, one tap from Connection & devices. */
export function MobileDrawerConnection({ connection, label, appIcon, address, onOpen }: {
  connection: MobileConnection; label: string; appIcon?: AppIcon; address: string; onOpen(): void
}) {
  return <button type="button" className="mobile-drawer-connection" data-connection={connection.state} aria-label={`连接与设备 · ${address || 'Mac 地址未记录'} · ${label}`} onClick={onOpen}>
    <BrandIcon icon={appIcon} className="mobile-drawer-connection__icon" size={36} />
    <span className="mobile-drawer-connection__text">
      <span className="mobile-drawer-connection__address" data-missing={address ? undefined : true}>{address || 'Mac 地址未记录'}</span>
      <span className="mobile-drawer-connection__state"><span className="mobile-status-dot" />{label}</span>
    </span>
    <ThemeNavigationSubmenuIcon size={16} />
  </button>
}
