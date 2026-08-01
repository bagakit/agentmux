import { BUILT_IN_AGENT_PROVIDER_IDS, type AgentProviderId, type BuiltInAgentProviderId } from '@agentmux/core'
import { Bot } from 'lucide-react'
import type { ReactNode } from 'react'
import hermesIconUrl from '../assets/agent-icons/hermes.png'
import traexIconUrl from '../assets/agent-icons/traex.png'
import grokIconUrl from '../assets/agent-icons/grok.png'
import geminiIconUrl from '../assets/agent-icons/gemini.png'
import antigravityIconUrl from '../assets/agent-icons/antigravity.png'
import cursorIconUrl from '../assets/agent-icons/cursor.png'

const BUILT_IN_AGENT_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  traex: 'TraeX',
  hermes: 'Hermes',
  pi: 'Pi',
  grok: 'Grok',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  // Kimi 有名字但**没有**离线品牌图形：仓库里没有 kimi 的图标资源，也不会凭空画一个近似的
  // 冒充它。于是它走下面 switch 的 `Bot` 兜底——「认得这个 Provider」与「有它的品牌标记」是
  // 两件事，这里如实分开：label 认得，标记中性。Droid 与 Copilot 同理。
  kimi: 'Kimi',
  droid: 'Droid',
  copilot: 'Copilot',
  opencode: 'OpenCode'
} satisfies Record<BuiltInAgentProviderId, string>

/**
 * 没有离线品牌图形的内置 Provider。仓库里没有它们的图标资源，也不会凭空画一个近似的冒充——
 * 「认得这个 Provider」与「有它的品牌标记」是两件事，这里如实分开：label 认得，标记中性（走 `Bot`）。
 *
 * 记的是**没有**的那几家而不是有的那些，因为这样新增一家 Provider 时它默认落进"应当有标记"，
 * 于是忘了加图标会被守卫抓住；反过来记"有的那些"则是新增一家默认被漏掉、一条断言都不红。
 *
 * 但这份豁免清单本身就是个消音器：往里加一个 id 就能让"必须画出品牌标记"那条断言对它闭嘴。
 * 所以它单独导出，让测试反过来质询它——每个声称"没有图形"的 id 必须**真的**落到 Bot 兜底。
 */
export const AGENT_PROVIDERS_WITHOUT_BRAND_MARK: readonly BuiltInAgentProviderId[] = ['kimi', 'droid', 'copilot', 'opencode']

/**
 * 有离线品牌标记的 Provider。**不是**内置 Provider 的全集：见上面那条。
 *
 * 从 Core 的运行时 SSOT 派生而不是手抄——此前那份手抄清单只列了 5 个，另外 4 个内置 Provider
 * 加进来时一条断言都没红。单独导出是为了让测试能按这份清单质询"每个声称有标记的都真画得出来"。
 */
export const AGENT_PROVIDERS_WITH_BRAND_MARK = BUILT_IN_AGENT_PROVIDER_IDS
  .filter((id) => !AGENT_PROVIDERS_WITHOUT_BRAND_MARK.includes(id))

export function agentProviderLabel(providerId: AgentProviderId): string {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_AGENT_LABELS, providerId)
    ? BUILT_IN_AGENT_LABELS[providerId as BuiltInAgentProviderId]
    : providerId
}

function CodexIcon({ size }: { size: number }) {
  // Geometry is the OpenAI mark for Codex.
  return (
    <svg fill="currentColor" fillRule="evenodd" height={size} width={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  )
}

function ClaudeIcon({ size }: { size: number }) {
  // Geometry and brand fill are the Claude mark.
  return (
    <svg height={size} width={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fillRule="nonzero" />
    </svg>
  )
}

function PiIcon({ size }: { size: number }) {
  // Geometry is the pi.dev mark.
  return (
    <svg height={size} width={size} viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}

/**
 * 一个 Provider 的离线身份标记。
 *
 * `providerId` 是**可选**的，因为「这个 Session 归哪个 Provider」本身就可能不存在或查不到：终端
 * Session 没有 Provider（`WorkspaceBoard` 的 `session.providerId` 就是 optional），而按 id 去 store
 * 反查也会在 Session 已退场、store 未装载时落空。缺失时走 `Bot` 兜底，这与未知的自定义 provider
 * 是同一条路——都不冒充某个内置 Agent。
 *
 * 这个签名是可选而不是必填，为的是**不让每个调用方各造一个绕法**：必填时调用方要么在外面写
 * `providerId ? <Icon/> : null`（于是缺失时整枚标记消失，留一个无法解释的空位），要么传 `''`
 * 之类的假值把「不存在」编码成一个合法值。两种都是把同一个判断复制到调用处。
 */
export function AgentProviderIcon({ providerId, size = 14 }: { providerId?: AgentProviderId; size?: number }) {
  let icon: ReactNode
  switch (providerId) {
    case 'codex': icon = <CodexIcon size={size} />; break
    case 'claude': icon = <ClaudeIcon size={size} />; break
    case 'traex': icon = <img src={traexIconUrl} width={size} height={size} alt="" draggable={false} />; break
    case 'hermes': icon = <img src={hermesIconUrl} width={size} height={size} alt="" draggable={false} />; break
    case 'pi': icon = <PiIcon size={size} />; break
    case 'grok': icon = <img src={grokIconUrl} width={size} height={size} alt="" draggable={false} />; break
    case 'gemini': icon = <img src={geminiIconUrl} width={size} height={size} alt="" draggable={false} />; break
    case 'antigravity': icon = <img src={antigravityIconUrl} width={size} height={size} alt="" draggable={false} />; break
    case 'cursor': icon = <img src={cursorIconUrl} width={size} height={size} alt="" draggable={false} />; break
    default: icon = <Bot size={size} strokeWidth={1.8} />
  }
  return (
    <span
      className="agent-provider-icon"
      data-agent-provider={providerId}
      data-agent-provider-known={
        providerId !== undefined && Object.prototype.hasOwnProperty.call(BUILT_IN_AGENT_LABELS, providerId)
      }
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}
