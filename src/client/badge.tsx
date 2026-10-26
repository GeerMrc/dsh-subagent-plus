/**
 * Read-only pinned-model badge for delegated sessions. Registered on two
 * session-scope list seats (`conversation.input.right` beside the official
 * model selector, and `conversation.session.header.utilities` so one-shot
 * read-only child windows keep the badge even when the composer is taken
 * over). Renders nothing on top-level sessions — their model stays owned by
 * the official selector — and nothing until the session has a readable route.
 * @module dsh-subagent-plus/client/badge
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: merges the session-scope seat props (useSession/useProjection)
// and the `modelSelection` projection key into the client type faces.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { badgeRoute } from './badge-logic.ts'
import { NS } from './locales.ts'
import { badgeEffortStyle, badgeRouteStyle, badgeStyle } from './styles.ts'

/** Both seats are session-scoped, so their standard props coincide. */
export type PinBadgeProps = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS>

export function PinBadge({ useSession, useProjection, t }: PinBadgeProps) {
  const subagent = useSession((snapshot: SessionSnapshot) => snapshot.subagent)
  const projection = useProjection('modelSelection')
  const route = badgeRoute(subagent, projection)
  if (route === undefined) return null
  const routeLabel = `${route.provider}/${route.model}`
  const fullLabel = route.effort === undefined ? routeLabel : `${routeLabel} · ${route.effort}`
  return (
    <span data-dsmp-badge style={badgeStyle} title={fullLabel} aria-label={t('badge.aria')}>
      <span style={badgeRouteStyle}>{routeLabel}</span>
      {route.effort === undefined
        ? null
        : <span style={badgeEffortStyle}>{` · ${route.effort}`}</span>}
    </span>
  )
}
