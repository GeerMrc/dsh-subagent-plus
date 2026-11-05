/**
 * The runtime-limits block absorbed into this plugin's settings card
 * (v0.3.2): the top sub-section of the merged card, above the candidate
 * list, editing the official `subagent` namespace through the shared config
 * form. It carries no card wrapper of its own (the merged card's single
 * border is the official page's one-card precedent) and no save button (the
 * page footer commits every dirty namespace). The block never disappears
 * with its namespace (T7): a namespace the host stops serving flips only
 * this block's body to an unavailable line, so an ns hiccup cannot flash
 * the hidden official page back into existence.
 *
 * @module dsh-subagent-plus/client/official-sections
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import { NS } from './locales.ts'
import type { NamespaceFormState, OfficialLimitsController, OfficialLimitsValue } from './official-surfaces.ts'
import {
  cardHeaderRowStyle,
  cardHeadingStyle,
  hintStyle,
  inputStyle,
  invalidStyle,
  statusTextStyle,
} from './settings-styles.ts'

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

/** The status branches the limits block shares (loading / unavailable / invalid). */
function NsStatusLine({ state, t }: { state: NamespaceFormState<unknown>; t: PropsLocale<typeof NS>['t'] }) {
  if (state.status === 'unavailable') return <p style={hintStyle}>{t('takeover.nsUnavailable')}</p>
  if (state.valueInvalid) return <p style={invalidStyle}>{t('takeover.valueInvalid')}</p>
  return null
}

/** The runtime-limits sub-section of the merged card: header row (title,
 *  takeover ⓘ, one-shot saved chip), status branches, and the two parsed
 *  numeric inputs writing the official `subagent` keys verbatim. */
export function LimitsBlock(props: {
  state: NamespaceFormState<OfficialLimitsValue>
  controller: OfficialLimitsController
  t: PropsLocale<typeof NS>['t']
}) {
  const { state, controller, t } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={cardHeaderRowStyle}>
        <h4 id="dsmp-limits" style={cardHeadingStyle}>{t('takeover.limitsTitle')}</h4>
        <Info label={t('takeover.limitsHelp')} text={t('takeover.limitsHelp')} />
        <span style={{ flex: 1 }} />
        {state.saved ? <span style={statusTextStyle('success')}>{t('action.saved')}</span> : null}
      </div>
      <NsStatusLine state={state} t={t} />
      {state.status === 'ready' && !state.valueInvalid && state.draft !== undefined
        ? (
          <>
            <LimitsBody state={state} controller={controller} t={t} />
            {state.invalid ? <p style={invalidStyle}>{t('takeover.limitsInvalid')}</p> : null}
          </>
          )
        : null}
    </div>
  )
}

/** The runtime-limits rows: the official limits geometry (SubagentLimitsFields
 *  .limits grid) — two responsive one-fr columns with a 16px gutter — each cell
 *  one horizontal row with a compact tabular-nums number input. */
function LimitsBody(props: {
  state: NamespaceFormState<OfficialLimitsValue>
  controller: Pick<OfficialLimitsController, 'setMaxDepth' | 'setMaxActiveSubagents'>
  t: PropsLocale<typeof NS>['t']
}) {
  const { draft } = props.state
  if (draft === undefined) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', columnGap: 16, rowGap: 8 }}>
      <LimitInputRow
        label={props.t('takeover.maxDepth')}
        value={String(draft.maxDepth)}
        min={0}
        invalid={props.state.invalid}
        onChange={props.controller.setMaxDepth}
      />
      <LimitInputRow
        label={props.t('takeover.maxActive')}
        value={String(draft.maxActiveSubagents)}
        min={1}
        invalid={props.state.invalid}
        onChange={props.controller.setMaxActiveSubagents}
      />
    </div>
  )
}

/** One limits cell: label left, compact fixed-width number input right — a
 *  one-to-three-digit integer never justifies a full-row input box. */
function LimitInputRow(props: {
  label: string
  value: string
  min: number
  invalid: boolean
  onChange: (text: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
      <span style={cardHeadingStyle}>{props.label}</span>
      <span style={{ flex: 1 }} />
      <input
        className={`dsmp-input${props.invalid ? ' dsmp-invalid' : ''}`}
        style={{ ...inputStyle, width: 64, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
        type="number" min={props.min} step={1} inputMode="numeric"
        value={props.value}
        aria-label={props.label}
        onChange={event => { props.onChange(event.target.value) }}
      />
    </div>
  )
}
