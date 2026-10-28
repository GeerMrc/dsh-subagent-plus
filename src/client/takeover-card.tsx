/**
 * The takeover card (v0.3.0 T5/T7): the banner naming what was taken over and
 * how to restore it, plus the two absorbed official sections — runtime limits
 * and the model-selection allowlist — each editing its official namespace
 * through the shared config form. The card renders while this plugin's own
 * settings namespace is served; an official namespace going away flips only
 * its own section to `unavailable`, never the card (T7).
 *
 * @module dsh-subagent-plus/client/takeover-card
 */
import { useSyncExternalStore, type CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import { NS } from './locales.ts'
import type { RouteOption } from './settings-controller.ts'
import type {
  NamespaceFormController,
  NamespaceFormState,
  OfficialAllowlistValue,
  OfficialLimitsValue,
} from './official-surfaces.ts'
import {
  cardHeadingStyle,
  cardHeaderRowStyle,
  cardStyle,
  hintStyle,
  invalidStyle,
  saveButtonStyle,
  statusTextStyle,
} from './settings-styles.ts'

/** Banner box: the takeover statement, distinct from plain hints. */
const bannerStyle: CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--dsw-alias-state-warn-primary)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
}

/** Sub-section divider inside the takeover card. */
const sectionDividerStyle: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  paddingTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
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

/** One official namespace's header row: title + hover help. */
function SectionHeader({ title, help }: { title: string; help: string }) {
  return (
    <div style={cardHeaderRowStyle}>
      <h5 style={{ ...cardHeadingStyle, margin: 0, fontSize: 13 }}>{title}</h5>
      <Info label={help} text={help} />
    </div>
  )
}

/** One namespace's save row: disabled while clean/blocked/saving, one-shot feedback. */
function SectionFooter(props: {
  clean: boolean
  blocked: boolean
  saving: boolean
  saved: boolean
  saveFailed: boolean
  conflict: boolean
  saveLabel: string
  savingLabel: string
  savedLabel: string
  failedLabel: string
  conflictLabel: string
  onSave: () => void
}) {
  const disabled = props.clean || props.blocked || props.saving
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" style={saveButtonStyle(disabled)} disabled={disabled} onClick={() => { props.onSave() }}>
        {props.saving ? props.savingLabel : props.saveLabel}
      </button>
      {props.saved ? <span style={statusTextStyle('success')}>{props.savedLabel}</span> : null}
      {props.saveFailed ? <span style={statusTextStyle('error')}>{props.failedLabel}</span> : null}
      {props.conflict ? <span style={statusTextStyle('warn')}>{props.conflictLabel}</span> : null}
    </div>
  )
}

/** The status branches every official section shares (loading / unavailable / invalid). */
function NsStatusLine({ state, t }: { state: NamespaceFormState<unknown>; t: PropsLocale<typeof NS>['t'] }) {
  if (state.status === 'unavailable') return <p style={hintStyle}>{t('takeover.nsUnavailable')}</p>
  if (state.valueInvalid) return <p style={invalidStyle}>{t('takeover.valueInvalid')}</p>
  return null
}

/** The two official controllers the card edits, shared with the client entry's wiring. */
export interface TakeoverControllers {
  limits: NamespaceFormController<OfficialLimitsValue>
  allowlist: NamespaceFormController<OfficialAllowlistValue>
}

/** Presentation component; every action is a controller call, every string a locale key. */
export function TakeoverCard(props: PropsLocale<typeof NS> & TakeoverControllers & { routes: readonly RouteOption[] }) {
  const { t } = props
  const limits = useSyncExternalStore(props.limits.subscribe, props.limits.snapshot)
  const allowlist = useSyncExternalStore(props.allowlist.subscribe, props.allowlist.snapshot)
  return (
    <section style={cardStyle} aria-labelledby="dsmp-takeover">
      <div style={cardHeaderRowStyle}>
        <h4 id="dsmp-takeover" style={cardHeadingStyle}>{t('takeover.title')}</h4>
      </div>
      <p style={bannerStyle}>{t('takeover.banner')}</p>

      <div style={sectionDividerStyle}>
        <SectionHeader title={t('takeover.limitsTitle')} help={t('takeover.limitsHelp')} />
        <NsStatusLine state={limits} t={t} />
        {limits.status === 'ready' && !limits.valueInvalid && limits.draft !== undefined
          ? <LimitsBody state={limits} controller={props.limits} t={t} />
          : null}
        {limits.status === 'ready' && !limits.valueInvalid && limits.draft !== undefined
          ? (
            <SectionFooter
              clean={limits.value !== undefined && JSON.stringify(limits.value) === JSON.stringify(limits.draft)}
              blocked={limitsBlock(limits)}
              saving={limits.saving}
              saved={limits.saved}
              saveFailed={limits.saveFailed}
              conflict={limits.conflict}
              saveLabel={t('action.save')} savingLabel={t('action.saving')} savedLabel={t('action.saved')} failedLabel={t('action.failed')} conflictLabel={t('action.conflict')}
              onSave={() => { void props.limits.save() }}
            />
            )
          : null}
      </div>

      <div style={sectionDividerStyle}>
        <SectionHeader title={t('takeover.allowlistTitle')} help={t('takeover.allowlistHelp')} />
        <NsStatusLine state={allowlist} t={t} />
        {allowlist.status === 'ready' && !allowlist.valueInvalid && allowlist.draft !== undefined
          ? <AllowlistBody state={allowlist} controller={props.allowlist} routes={props.routes} t={t} />
          : null}
        {allowlist.status === 'ready' && !allowlist.valueInvalid && allowlist.draft !== undefined
          ? (
            <SectionFooter
              clean={allowlist.value !== undefined && JSON.stringify(allowlist.value) === JSON.stringify(allowlist.draft)}
              blocked={false}
              saving={allowlist.saving}
              saved={allowlist.saved}
              saveFailed={allowlist.saveFailed}
              conflict={allowlist.conflict}
              saveLabel={t('action.save')} savingLabel={t('action.saving')} savedLabel={t('action.saved')} failedLabel={t('action.failed')} conflictLabel={t('action.conflict')}
              onSave={() => { void props.allowlist.save() }}
            />
            )
          : null}
      </div>
    </section>
  )
}

/** Placeholder bodies; the interactive controls land with W-04/W-05. */
function LimitsBody(props: { state: NamespaceFormState<OfficialLimitsValue>; controller: NamespaceFormController<OfficialLimitsValue>; t: PropsLocale<typeof NS>['t'] }) {
  return <p style={hintStyle}>…</p>
}

/** See {@link LimitsBody}. */
function AllowlistBody(props: { state: NamespaceFormState<OfficialAllowlistValue>; controller: NamespaceFormController<OfficialAllowlistValue>; routes: readonly RouteOption[]; t: PropsLocale<typeof NS>['t'] }) {
  return <p style={hintStyle}>…</p>
}

/** Whether the limits draft is blocked from saving; interactive rows land with W-04. */
function limitsBlock(state: NamespaceFormState<OfficialLimitsValue>): boolean {
  return false
}
