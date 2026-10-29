/**
 * The official subagent sections absorbed into this plugin's settings page
 * (v0.3.1 D2): each section edits one official namespace through the shared
 * config form and renders inside the main page layout — the runtime limits
 * card above the candidate list, the allowlist card below the strategy rows.
 * A section never disappears with its namespace (T7): a namespace the host
 * stops serving flips only its own body to an unavailable line, so an ns hiccup
 * cannot flash the hidden official page back into existence. Sections carry no
 * save buttons of their own — the page's single footer commits every dirty
 * namespace through the unified save controller.
 *
 * @module dsh-subagent-plus/client/official-sections
 */
import type { CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import { NS } from './locales.ts'
import type {
  NamespaceFormState,
  OfficialLimitsController,
  OfficialLimitsValue,
} from './official-surfaces.ts'
import {
  cardHeaderRowStyle,
  cardHeadingStyle,
  cardStyle,
  hintStyle,
  inputStyle,
  invalidStyle,
  statusTextStyle,
} from './settings-styles.ts'

/** Banner box: the takeover statement, distinct from plain hints. */
export const bannerStyle: CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--dsw-alias-state-warn-primary)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
}

/** Hover ⓘ: the dsh-websearch pattern shared with the main section. */
function Info({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip label={text} side="bottom" delayMs={400} maxWidth={360} portal>
      <button type="button" aria-label={label} style={{ border: 'none', background: 'transparent', color: 'inherit', opacity: 0.6, cursor: 'help', padding: 0, display: 'inline-flex' }}>
        <QuestionIcon />
      </button>
    </Tooltip>
  )
}

/** One section's header row: title + hover help + the section's one-shot feedback. */
export function SectionHeader(props: { title: string; help: string; saved?: boolean; savedLabel: string }) {
  return (
    <div style={cardHeaderRowStyle}>
      <h4 style={cardHeadingStyle}>{props.title}</h4>
      <Info label={props.help} text={props.help} />
      <span style={{ flex: 1 }} />
      {props.saved ? <span style={statusTextStyle('success')}>{props.savedLabel}</span> : null}
    </div>
  )
}

/** The status branches every official section shares (loading / unavailable / invalid). */
export function NsStatusLine({ state, t }: { state: NamespaceFormState<unknown>; t: PropsLocale<typeof NS>['t'] }) {
  if (state.status === 'unavailable') return <p style={hintStyle}>{t('takeover.nsUnavailable')}</p>
  if (state.valueInvalid) return <p style={invalidStyle}>{t('takeover.valueInvalid')}</p>
  return null
}

/** The runtime-limits card: two parsed numeric inputs writing the official
 *  `subagent` namespace keys verbatim; sits above the candidate list. */
export function LimitsSection(props: {
  state: NamespaceFormState<OfficialLimitsValue>
  controller: OfficialLimitsController
  t: PropsLocale<typeof NS>['t']
}) {
  const { state, controller, t } = props
  return (
    <section style={cardStyle} aria-labelledby="dsmp-limits">
      <SectionHeader title={t('takeover.limitsTitle')} help={t('takeover.limitsHelp')} saved={state.saved} savedLabel={t('action.saved')} />
      <NsStatusLine state={state} t={t} />
      {state.status === 'ready' && !state.valueInvalid && state.draft !== undefined
        ? (
          <>
            <LimitsBody state={state} controller={controller} t={t} />
            {state.invalid ? <p style={invalidStyle}>{t('takeover.limitsInvalid')}</p> : null}
          </>
          )
        : null}
    </section>
  )
}

/** The runtime-limits rows: two parsed numeric inputs writing the official keys. */
function LimitsBody(props: {
  state: NamespaceFormState<OfficialLimitsValue>
  controller: Pick<OfficialLimitsController, 'setMaxDepth' | 'setMaxActiveSubagents'>
  t: PropsLocale<typeof NS>['t']
}) {
  const { draft } = props.state
  if (draft === undefined) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.maxDepth')}</span>
        <span style={{ flex: 1 }} />
        <input
          className={`dsmp-input${props.state.invalid ? ' dsmp-invalid' : ''}`}
          style={{ ...inputStyle, height: 32, width: 'auto', minWidth: 0 }}
          type="number" min={0} step={1} inputMode="numeric"
          value={String(draft.maxDepth)}
          aria-label={props.t('takeover.maxDepth')}
          onChange={event => { props.controller.setMaxDepth(event.target.value) }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.maxActive')}</span>
        <span style={{ flex: 1 }} />
        <input
          className={`dsmp-input${props.state.invalid ? ' dsmp-invalid' : ''}`}
          style={{ ...inputStyle, height: 32, width: 'auto', minWidth: 0 }}
          type="number" min={1} step={1} inputMode="numeric"
          value={String(draft.maxActiveSubagents)}
          aria-label={props.t('takeover.maxActive')}
          onChange={event => { props.controller.setMaxActiveSubagents(event.target.value) }}
        />
      </div>
    </div>
  )
}
