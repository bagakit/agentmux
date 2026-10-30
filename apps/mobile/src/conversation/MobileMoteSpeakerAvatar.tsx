import type { AgentMuxSpaceAppearance } from '@agentmux/core/control'
import { MoteFace } from '@agentmux/client-ui/components/MoteFace'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { SpaceAppearanceIcon } from '@agentmux/client-ui/components/SpaceAppearanceIcon'
import { isMoteFace } from '@agentmux/client-ui/mote-face'

/** Static identity decoration only: no per-message IO, activity or motion owner. */
export function MobileMoteSpeakerAvatar({ spaceId, name, appearance, size = 18 }: {
  spaceId: string; name: string; appearance?: AgentMuxSpaceAppearance | undefined; size?: number
}) {
  const face = appearance?.parts && isMoteFace(appearance.parts) ? appearance.parts : null
  return <span className="mobile-object-avatar mobile-conversation-mote-avatar" data-mote-speaker={spaceId} aria-hidden="true" style={{ width: size, height: size }}>
    {face ? <span className="mobile-mote-face-model" style={{ transform: `scale(${size / 64})` }}><MoteFace face={face} expression="identity" /></span>
      : appearance?.glyph || appearance?.image?.dataUrl ? <SpaceAppearanceIcon name={name} glyph={appearance.glyph} image={appearance.image?.dataUrl} size={size} />
        : <MoteIcon size={size} interactive={false} />}
  </span>
}
