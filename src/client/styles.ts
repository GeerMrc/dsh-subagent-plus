/**
 * Read-only badge styles mirroring the official model-selector trigger
 * geometry (13px / 28px / borderless / transparent) so the badge sits in the
 * composer row as a native sibling; only the text color differs — the stable
 * amber state token marks "this child is pinned", instead of the interactive
 * label color, and never a link color that would suggest clickability.
 * @module dsh-subagent-plus/client/styles
 */
import type { CSSProperties } from 'react'

export const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  height: '28px',
  padding: '0 4px 0 8px',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-state-warn-primary)',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  cursor: 'default',
  userSelect: 'text',
  // The two-segment badge caps its box (px, not cqw — the header seat's
  // container-query context is not guaranteed) and ellipsises per segment.
  maxWidth: 240,
  overflow: 'hidden',
}

/** Main `provider/model` segment: keeps the badge's amber identity color. */
export const badgeRouteStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flexShrink: 1,
}

/** Effort segment: caption color, the first to shrink when space runs out
 *  (the official model trigger's effort span does the same). */
export const badgeEffortStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flexShrink: 1000,
  color: 'var(--dsw-alias-label-caption)',
}
