/**
 * Transitional takeover card: since the runtime-limits section moved into the
 * main settings page (v0.3.1 D2), this card carries only the model-selection
 * allowlist until it migrates onto the main page layout as well. It disappears
 * entirely once the allowlist section lands beside the limits card.
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
  NamespaceFormState,
  OfficialAllowlistController,
  OfficialAllowlistValue,
  OfficialLimitsController,
} from './official-surfaces.ts'
import { NsStatusLine, SectionHeader } from './official-sections.tsx'
import { routeShort, Switch } from './settings-section.tsx'
import {
  cardHeadingStyle,
  cardStyle,
  hintStyle,
  saveButtonStyle,
  statusTextStyle,
} from './settings-styles.ts'

/** The two official controllers the page edits, shared with the client entry's wiring. */
export interface TakeoverControllers {
  limits: OfficialLimitsController
  allowlist: OfficialAllowlistController
}

/** Sub-section divider inside the card. */
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

/** The allowlist's save row: disabled while clean/saving, one-shot feedback. */
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

/** Presentation component; every action is a controller call, every string a locale key. */
export function TakeoverCard(props: PropsLocale<typeof NS> & { allowlist: OfficialAllowlistController; routes: readonly RouteOption[] }) {
  const { t } = props
  const allowlist = useSyncExternalStore(props.allowlist.subscribe, props.allowlist.snapshot)
  return (
    <section style={cardStyle} aria-labelledby="dsmp-takeover">
      <div style={sectionDividerStyle}>
        <SectionHeader title={t('takeover.allowlistTitle')} help={t('takeover.allowlistHelp')} saved={allowlist.saved} savedLabel={t('action.saved')} />
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

/** The official allowlist: the enabled switch plus a route checklist. Stored
 *  routes that left the catalogue stay checked and tagged so a catalogue
 *  hiccup never silently deauthorizes a route. */
function AllowlistBody(props: {
  state: NamespaceFormState<OfficialAllowlistValue>
  controller: Pick<OfficialAllowlistController, 'setEnabled' | 'toggleRoute'>
  routes: readonly RouteOption[]
  t: PropsLocale<typeof NS>['t']
}) {
  const { draft } = props.state
  if (draft === undefined) return null
  const checked = (route: { provider: string; model: string }): boolean =>
    draft.allowedModels.some(entry => entry.provider === route.provider && entry.model === route.model)
  const storedMissing = draft.allowedModels.filter(entry =>
    !props.routes.some(route => route.provider === entry.provider && route.model === entry.model))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.allowlistEnabled')}</span>
        <Info label={props.t('takeover.allowlistEnabledHelp')} text={props.t('takeover.allowlistEnabledHelp')} />
        <span style={{ flex: 1 }} />
        <Switch
          checked={draft.enabled}
          onChange={props.controller.setEnabled}
          label={props.t('takeover.allowlistEnabled')}
          title={props.t('takeover.allowlistEnabledHelp')}
        />
      </div>
      {props.routes.map(route => (
        <label key={`${route.provider}\0${route.model}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={checked(route)}
            onChange={() => { props.controller.toggleRoute({ provider: route.provider, model: route.model }) }}
            aria-label={`${props.t('takeover.allowlistTitle')} ${route.provider}/${route.model}`}
          />
          <span>{routeShort(route)}</span>
        </label>
      ))}
      {storedMissing.map(entry => (
        <label key={`${entry.provider}\0${entry.model}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked
            onChange={() => { props.controller.toggleRoute(entry) }}
            aria-label={`${props.t('takeover.allowlistTitle')} ${entry.provider}/${entry.model}`}
          />
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
            {`${entry.provider}/${entry.model}${props.t('takeover.allowlistUnavailable')}`}
          </span>
        </label>
      ))}
      {draft.allowedModels.length === 0 ? <p style={hintStyle}>{props.t('takeover.allowlistEmpty')}</p> : null}
    </div>
  )
}
