/**
 * Inline styles for the settings section, mirroring the official settings
 * page's measured values: 13px/500 labels, 34px inputs (32px selects),
 * 0.5px hairline separators, radius 12 cards, 36×20 switches, and the
 * reversed primary save button. Interactive pseudo-classes live in one
 * injected <style> block (single-file bundle, no CSS imports); every color
 * rides a `--dsw-alias-*` semantic token.
 *
 * @module dsh-subagent-plus/client/settings-styles
 */

export const rootStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 720,
  width: '100%',
} as const

export const cardStyle = {
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
} as const

export const fieldRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
} as const

export const inputStyle = {
  height: 34,
  padding: '0 12px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: 1.5,
  width: '100%',
  boxSizing: 'border-box',
} as const

/* Compact inline select (the dsh-websearch form): auto width so the box hugs
   its content, 32px tall, chevron tucked at the right edge. */
export const selectStyle = {
  ...inputStyle,
  width: 'auto',
  minWidth: 0,
  height: 32,
  margin: 0,
  appearance: 'none',
  WebkitAppearance: 'none',
  paddingRight: 24,
  backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2381858C\' stroke-width=\'2.4\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'/%3E%3C/svg%3E")',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 6px center',
} as const

export const hintStyle = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

export const invalidStyle = {
  ...hintStyle,
  color: 'var(--dsw-alias-state-error-primary)',
} as const

/** Hover-tooltip anchor (the dsh-websearch form): transparent, inherits the
   label color at reduced opacity, help cursor, no fixed box. */
export const infoButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.6,
  cursor: 'help',
} as const

/** Page header: h3 16px/500 with the ⓘ inline, switch at the right edge. */
export const pageHeaderRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
} as const

export const pageHeadingStyle = {
  margin: 0,
  fontSize: 16,
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--dsw-alias-label-primary)',
} as const

/* Matches the settings-General row description (DeveloperToolsRow.module.css
 * 12px/18px label-secondary), not the Models page intro. */
export const pageDescriptionStyle = {
  margin: 0,
  marginTop: 4,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
} as const

/** Card header row: h4 12px/500 secondary, ⓘ after the title, spacer, right control. */
export const cardHeadingStyle = {
  margin: 0,
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
} as const

export const cardHeaderRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
} as const

export const iconButtonStyle = {
  width: 24,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  padding: 0,
} as const

export const listRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 8,
  padding: 6,
  borderRadius: 12,
} as const

export const indexChipStyle = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
  minWidth: 14,
  textAlign: 'right' as const,
} as const

export const routeNameStyle = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
} as const

export const routeSubStyle = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
} as const

/* Track follows the dsh-websearch switch shape (36x20, pad 2, r10): green
   only when enabled — the semantic the user picked for this page. */
export const switchStyle = (checked: boolean) => ({
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  flex: '0 0 auto' as const,
  width: 36,
  height: 20,
  padding: 2,
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  background: checked ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l3)',
})

export const switchThumbStyle = (checked: boolean) => ({
  display: 'block' as const,
  position: 'absolute' as const,
  top: 2,
  left: 2,
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: 'var(--dsw-alias-label-primary-foreground)',
  transition: 'transform 120ms ease',
  transform: checked ? 'translateX(16px)' : 'translateX(0px)',
})

export const saveButtonStyle = (disabled: boolean) => ({
  borderRadius: 12,
  padding: '5px 14px',
  fontSize: 13,
  lineHeight: 1.5,
  border: 'none',
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
})

export const statusTextStyle = (tone: 'success' | 'error' | 'warn') => ({
  fontSize: 12,
  lineHeight: 1.5,
  color: tone === 'success'
    ? 'var(--dsw-alias-state-success-primary)'
    : tone === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-state-warn-label)',
})

export const foldButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  padding: 0,
} as const

/** Interactive pseudo-classes for the class-marked controls in one injected block. */
export const settingsCss = `
.dsmp-hover:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-4); }
.dsmp-input:focus, .dsmp-select:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.dsmp-invalid { border-color: var(--dsw-alias-state-error-primary) !important; }
.dsmp-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-focus-ring); outline-offset: 2px; }
.dsmp-pop-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
@media (prefers-reduced-motion: reduce) { .dsmp-switch, .dsmp-switch > span { transition: none; } }
`

/** Route select: compact box (the closed value truncates with an ellipsis);
 *  the full route name rides the hover tooltip and option titles. */
export const routeSelectStyle = {
  ...selectStyle,
  maxWidth: 240,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

/** One row inside the advanced fold: no divider — spacing separates rows, the
 *  fold header keeps the single boundary line above the group. */
export const advancedRowStyle = {
  display: 'flex',
  gap: 8,
  flexDirection: 'row',
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '8px 0',
} as const

/** Advanced row title (13px/500, primary). */
export const advancedTitleStyle = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
} as const

/** The model-name trigger: transparent text button carrying the row's two-line
 *  label — hovering or clicking it reveals the action popover. */
export const nameTriggerStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  textAlign: 'left' as const,
  cursor: 'pointer',
  borderRadius: 8,
} as const

/** Compact horizontal action popover: one line of short text buttons, flush
 *  against the name (any margin is a dead zone that closes the popup before
 *  the pointer crosses it) with generous button hit areas. */
export const rowPopupStyle = {
  position: 'absolute' as const,
  top: '100%',
  left: 0,
  marginTop: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '4px 6px',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  boxShadow: 'var(--dsw-elevation-prominent)',
  whiteSpace: 'nowrap' as const,
  zIndex: 20,
} as const

/** One popover text button (12px, quiet until hover). */
export const rowPopupButtonStyle = {
  border: 'none',
  background: 'transparent',
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
} as const

/* Which subagent window you are in: inside the sibling-switcher popup, the
 * row of the child you currently have open tints the plugin's amber identity
 * color, on top of the official bold "current" marker. The popup rows are
 * portaled to document.body, so this document-level rule keys on the
 * official aria contracts — the popup's `role="tree"` container
 * (SubagentHeaderLineage.tsx:709) plus the current row's `aria-current`
 * (set only on the child you have open). Scoping to the tree container keeps
 * the rule off any other treeitem the host may render; label spans inherit,
 * summary/metrics keep their own tertiary color; no hashed official class
 * names, no !important. If the host restructures the popup the tint silently
 * disappears — pure appearance, no functional loss. Injected for the page
 * lifetime by the client entry. */
export const PAGE_STYLE_CSS = `
[role='tree'] [role='treeitem'][aria-current='true'] { color: var(--dsw-alias-state-warn-primary); }
`
