/**
 * Host icon resolution across ui-primitives generations, trimmed to the one
 * icon this client half needs. Upstream renamed the fixed-14px outline family
 * to stroke-weight names (`…Outline14` → `…OutlineRegular`); older hosts
 * still provide only the legacy names through the external bundle contract,
 * so the icon resolves at module load to the first export the host actually
 * provides (the dsh-websearch precedent).
 *
 * @module dsh-subagent-plus/client/host-icons
 */
import type { ComponentType } from 'react'
import {
  IconQuestionOutlineRegular,
  // Legacy export: type via the augmentation below, undefined at runtime on
  // newer hosts (bundled externals resolve missing names to undefined), so
  // the `??` pick below stays safe there.
  IconQuestionOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** The face the host package's own `IconProps` serves. */
interface HostIconFace {
  size?: number | undefined
  className?: string | undefined
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  // Legacy export absent from the package's own types since the rename;
  // declared locally so the value import type-checks while staying undefined
  // on newer hosts.
  export const IconQuestionOutline14: ComponentType<HostIconFace>
}

/** Host-provided question outline icon (any supported generation). */
export const QuestionIcon: ComponentType<HostIconFace> = IconQuestionOutlineRegular ?? IconQuestionOutline14
