/**
 * The plugin's settings section: one header switch (takeover, default on),
 * one model card whose bottom row carries the assignment strategy, a fallback
 * card, and an advanced fold. Every edit lands in a local draft and one Save
 * commits the changed fields atomically behind the shared config form's
 * revision fence.
 *
 * Interaction and layout follow the dsh-websearch section: long explanations
 * sit behind a hover ⓘ tooltip (Tooltip primitive, question icon), short
 * operational hints stay as 12px text; selects are compact auto-width boxes;
 * switches are 36×20 green-when-on at a row's right edge.
 *
 * @module dsh-subagent-plus/client/settings-section
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import type { RouteOption, SettingsSectionController, SettingsUiState } from './settings-controller.ts'
import { effortDefaultLabel, effortOptions, listedRoutesOf } from './settings-controller.ts'
import { NS } from './locales.ts'
import {
  nameTriggerStyle,
  rowPopupButtonStyle,
  rowPopupStyle,
  cardHeaderRowStyle,
  cardHeadingStyle,
  cardStyle,
  fieldRowStyle,
  foldButtonStyle,
  hintStyle,
  infoButtonStyle,
  inputStyle,
  invalidStyle,
  indexChipStyle,
  listRowStyle,
  pageDescriptionStyle,
  pageHeaderRowStyle,
  pageHeadingStyle,
  rootStyle,
  advancedRowStyle,
  advancedTitleStyle,
  routeNameStyle,
  routeSelectStyle,
  routeSubStyle,
  saveButtonStyle,
  selectStyle,
  settingsCss,
  statusTextStyle,
  switchStyle,
  switchThumbStyle,
} from './settings-styles.ts'

/** One strategy id paired with its locale key. */
const STRATEGY_KEYS = [
  ['pinned', 'strategy.pinned'],
  ['round-robin', 'strategy.round-robin'],
  ['random', 'strategy.random'],
  ['priority', 'strategy.priority'],
] as const

type StrategyId = typeof STRATEGY_KEYS[number][0]

const routeValue = (route: RouteOption): string => `${route.provider}\0${route.model}`

/** Short closed-box label (the browser-plus translate pattern): the select
 *  stays compact; the full route rides the hover tooltip and the option title. */
const routeShort = (route: { providerName: string; modelName: string }): string =>
  `${route.providerName} · ${route.modelName}`

/** Full route text for hover tooltips and option titles. */
const routeFull = (route: { providerName: string; modelName: string; provider: string; model: string }): string =>
  `${route.providerName} · ${route.provider}/${route.model} — ${route.modelName}`

/** Hover ⓘ: the dsh-websearch pattern — Tooltip wraps a borderless help-cursor anchor. */
function Info({ label, text, delayMs }: { label: string; text: string; delayMs: number }) {
  return (
    <Tooltip label={text} side="bottom" delayMs={delayMs} maxWidth={360} portal>
      <button type="button" aria-label={label} style={infoButtonStyle}>
        <QuestionIcon />
      </button>
    </Tooltip>
  )
}

/** Per-row actions anchored on the model name: hovering (or clicking) the
 *  name reveals a compact horizontal popover carrying only the moves the row
 *  position allows (first row: 下移+删除, last: 上移+删除, middle: both) —
 *  boundary rows never render a dead action. */
function RowNameCell(props: {
  label: string
  sub: string
  popupLabel: string
  index: number
  count: number
  moveUp: string
  moveDown: string
  remove: string
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement | null>(null)
  const canUp = props.index > 0
  const canDown = props.index < props.count - 1
  // A click PINS the popup open (hover alone already opens it; toggling here
  // would close what hovering just opened); pointer-down anywhere else closes.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])
  return (
    <span
      ref={anchor}
      style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}
      onMouseEnter={() => { setOpen(true) }}
      onMouseLeave={() => { setOpen(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
    >
      <button
        type="button"
        className="dsmp-hover"
        style={nameTriggerStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.popupLabel}
        onClick={() => { setOpen(true) }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={routeNameStyle}>{props.label}</span>
          <span style={routeSubStyle}>{props.sub}</span>
        </span>
      </button>
      {open
        ? (
          <span role="menu" aria-label={props.popupLabel} style={rowPopupStyle}>
            {canUp
              ? <button type="button" role="menuitem" className="dsmp-pop-btn" style={rowPopupButtonStyle} onClick={() => { setOpen(false); props.onMove(-1) }}>{props.moveUp}</button>
              : null}
            {canDown
              ? <button type="button" role="menuitem" className="dsmp-pop-btn" style={rowPopupButtonStyle} onClick={() => { setOpen(false); props.onMove(1) }}>{props.moveDown}</button>
              : null}
            <button type="button" role="menuitem" className="dsmp-pop-btn" style={{ ...rowPopupButtonStyle, color: 'var(--dsw-alias-state-error-primary)' }} onClick={() => { setOpen(false); props.onRemove() }}>{props.remove}</button>
          </span>
          )
        : null}
    </span>
  )
}

/** One model's reasoning-effort select: the always-present default row plus
 *  the model's own efforts by name; a stored id outside the current set stays
 *  visible (stale) so loaded values are never silently dropped. */
function EffortSelect(props: {
  label: string
  route: { efforts?: readonly { id: string; name: string }[]; defaultEffort?: string } | undefined
  value: string
  onChange: (value: string) => void
  defaultLabel: string
  defaultHoverLabel: string
  defaultHoverPlainLabel: string
  noneLabel: string
  staleTitle?: string
}) {
  const hasEfforts = props.route?.efforts !== undefined && props.route.efforts.length > 0
  // Distinguish "not in the catalogue" (stored effort kept verbatim) from a
  // genuine no-levels model.
  const noneTitle = props.route === undefined ? props.staleTitle ?? props.noneLabel : props.noneLabel
  const { options, stale } = effortOptions(props.route, props.value)
  const select = (
    <select
      className="dsmp-select"
      style={{ ...routeSelectStyle, maxWidth: 120 }}
      value={hasEfforts ? props.value : ''}
      disabled={!hasEfforts}
      aria-label={props.label}
      title={hasEfforts ? (props.value === '' ? effortDefaultLabel(props.route, props.defaultHoverLabel, props.defaultHoverPlainLabel) : props.value) : noneTitle}
      onChange={event => { props.onChange(event.target.value) }}
    >
      {hasEfforts
        ? (
          <>
            <option value="">{props.defaultLabel}</option>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </>
          )
        : <option value="">{props.noneLabel}</option>}
    </select>
  )
  return stale ? <span title={props.value} style={{ display: 'inline-flex' }}>{select}</span> : select
}

function Switch({ checked, onChange, label, title }: { checked: boolean; onChange: (value: boolean) => void; label: string; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className="dsmp-switch"
      style={switchStyle(checked)}
      onClick={() => { onChange(!checked) }}
    >
      <span style={switchThumbStyle(checked)} />
    </button>
  )
}

/** Presentation component; every action is a controller call, every string a locale key. */
export function SettingsSection(props: PropsLocale<typeof NS> & { controller: SettingsSectionController }) {
  const { t, controller } = props
  const state: SettingsUiState = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return (
    <div data-dsmp-settings style={rootStyle}>
      <style>{settingsCss}</style>
      {state.status === 'unavailable'
        ? <p style={invalidStyle}>{t('status.unavailable')}</p>
        : state.valueInvalid
          ? <p style={invalidStyle}>{t('status.valueInvalid')}</p>
          : state.draft === undefined
            ? <p style={hintStyle}>…</p>
          : (
              <>
                {state.catalogFailed ? <p style={invalidStyle}>{t('status.catalogFailed')}</p> : null}
                <Editor state={state} controller={controller} t={t} />
              </>
              )}
    </div>
  )
}

type EditorProps = {
  state: SettingsUiState
  controller: SettingsSectionController
  t: PropsLocale<typeof NS>['t']
}

function Editor({ state, controller, t }: EditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const draft = state.draft
  if (draft === undefined) return null
  const listed = listedRoutesOf(state)
  const pinnedRoute = state.routes.find(route => route.provider === draft.provider && route.model === draft.model) ?? null
  const fallbackRoute = state.routes.find(route => route.provider === draft.fallbackProvider && route.model === draft.fallbackModel) ?? null
  const pinnedHover = pinnedRoute === null && draft.provider === ''
    ? undefined
    : state.routes.find(route => route.provider === draft.provider && route.model === draft.model) !== undefined || pinnedRoute !== null
      ? routeFull(pinnedRoute ?? { providerName: draft.provider, modelName: draft.model, provider: draft.provider, model: draft.model })
      : `${draft.provider}/${draft.model}`
  const blocked = state.structural.length > 0 || state.degraded.length > 0 || state.cooldownInvalid
  const dirty = state.value !== undefined && JSON.stringify(state.value) !== JSON.stringify(draft)

  return (
    <>
      <header>
        <div style={pageHeaderRowStyle}>
          <h3 style={pageHeadingStyle}>{t('title')}</h3>
          <span style={{ flex: 1 }} />
          <Switch
            checked={draft.enabled}
            onChange={controller.setEnabled}
            label={draft.enabled ? t('status.active') : t('status.disabled')}
            title={t('status.officialNote')}
          />
        </div>
        <p style={pageDescriptionStyle}>{t('description')}</p>
      </header>

      <section style={cardStyle} aria-labelledby="dsmp-routes">
        <div style={cardHeaderRowStyle}>
          <h4 id="dsmp-routes" style={cardHeadingStyle}>
            {draft.strategy === 'pinned' ? t('strategy.pinnedRoute') : t('list.title')}
          </h4>
          <Info
            label={draft.strategy === 'pinned' ? t('strategy.pinnedRouteHelp') : t('list.help')}
            text={draft.strategy === 'pinned' ? t('strategy.pinnedRouteHelp') : t('list.help')}
            delayMs={400}
          />
          <span style={{ flex: 1 }} />
          {draft.strategy === 'pinned'
            ? (
              <>
                <Tooltip label={pinnedHover ?? t('strategy.pinnedPlaceholder')} side="bottom" delayMs={200} maxWidth={360} portal>
                  <select
                    className="dsmp-select"
                    style={routeSelectStyle}
                    value={pinnedRoute === null && draft.provider === '' ? '' : pinnedRoute !== null ? routeValue(pinnedRoute) : `${draft.provider}\0${draft.model}`}
                    aria-label={t('strategy.pinnedRoute')}
                    title={pinnedHover ?? t('strategy.pinnedPlaceholder')}
                    onChange={event => { controller.setPinnedRoute(routeFromValue(state, event.target.value)) }}
                  >
                    <option value="">{t('strategy.pinnedPlaceholder')}</option>
                    {state.routes.map(route => <option key={routeValue(route)} value={routeValue(route)} title={routeFull(route)}>{routeShort(route)}</option>)}
                  </select>
                </Tooltip>
                {draft.provider !== ''
                  ? (
                    <EffortSelect
                      label={t('strategy.effort')} route={pinnedRoute ?? undefined} value={draft.reasoningEffort}
                      onChange={controller.setPinnedEffort}
                      defaultLabel={t('effort.default')} defaultHoverLabel={t('effort.defaultHover')} defaultHoverPlainLabel={t('effort.defaultHoverPlain')} noneLabel={t('effort.none')} staleTitle={t('list.unavailable')}
                    />
                    )
                  : null}
              </>
              )
            : null}
        </div>

        {draft.strategy === 'pinned'
          ? <p style={hintStyle}>{t('strategy.pinnedPlaceholder')}</p>
          : (
            <>
              {listed.length === 0 ? <p style={hintStyle}>{t('list.empty')}</p> : null}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {listed.map((route, index) => (
                  <div key={`${route.provider}\0${route.model}`} className="dsmp-hover" style={listRowStyle}>
                    <span style={indexChipStyle}>{index + 1}</span>
                    <RowNameCell
                      label={`${route.providerName} · ${route.modelName}`}
                      sub={`${route.provider}/${route.model}${route.available ? '' : ` · ${t('list.unavailable')}`}`}
                      popupLabel={`${t('list.rowActions')} ${route.provider}/${route.model}`}
                      index={index} count={listed.length}
                      moveUp={t('list.moveUp')} moveDown={t('list.moveDown')} remove={t('list.remove')}
                      onMove={delta => { controller.moveRoute(index, delta) }}
                      onRemove={() => { controller.removeRoute(index) }}
                    />
                    {route.available && route.efforts !== undefined && route.efforts.length > 0
                      ? (
                        <EffortSelect
                          label={`${t('strategy.effort')} ${route.provider}/${route.model}`} route={route}
                          value={draft.priority[index]?.reasoningEffort ?? ''}
                          onChange={value => { controller.setRouteEffort(index, value) }}
                          defaultLabel={t('effort.default')} defaultHoverLabel={t('effort.defaultHover')} defaultHoverPlainLabel={t('effort.defaultHoverPlain')} noneLabel={t('effort.none')}
                        />
                        )
                      : null}

                  </div>
                ))}
              </div>
              <div style={{ ...fieldRowStyle, gap: 8, flexDirection: 'row', alignItems: 'center' }}>
                <span style={cardHeadingStyle}>{t('list.add')}</span>
                <span style={{ flex: 1 }} />
                <select
                  className="dsmp-select"
                  style={routeSelectStyle}
                  value=""
                  disabled={state.atLimit}
                  aria-label={t('list.add')}
                  onChange={event => {
                    const route = routeFromValue(state, event.target.value)
                    if (route !== null) controller.addRoute(route)
                  }}
                >
                  <option value="">{state.atLimit ? t('list.max') : t('list.addPlaceholder')}</option>
                  {state.addableRoutes.map(route => <option key={routeValue(route)} value={routeValue(route)} title={routeFull(route)}>{routeShort(route)}</option>)}
                </select>
              </div>
            </>
            )}

        <div style={{ ...fieldRowStyle, gap: 8, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={cardHeadingStyle}>{t('strategy.label')}</span>
          <Info label={t('strategy.help')} text={t('strategy.help')} delayMs={400} />
          <span style={{ flex: 1 }} />
          <select
            className="dsmp-select"
            style={selectStyle}
            value={draft.strategy}
            aria-label={t('strategy.label')}
            onChange={event => { controller.setStrategy(event.target.value as StrategyId) }}
          >
            {STRATEGY_KEYS.map(([id, key]) => <option key={id} value={id}>{t(key)}</option>)}
          </select>
        </div>
      </section>

      <div style={{ ...fieldRowStyle, gap: 8, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{t('fallback.title')}</span>
        <Info label={t('fallback.help')} text={t('fallback.help')} delayMs={400} />
        <span style={{ flex: 1 }} />
        <Tooltip label={fallbackRoute === null ? t('fallback.off') : routeFull(fallbackRoute)} side="bottom" delayMs={200} maxWidth={360} portal>
          <select
            className="dsmp-select"
            style={routeSelectStyle}
            value={fallbackRoute === null ? '' : routeValue(fallbackRoute)}
            aria-label={t('fallback.title')}
            title={fallbackRoute === null ? t('fallback.off') : routeFull(fallbackRoute)}
            onChange={event => { controller.setFallbackRoute(routeFromValue(state, event.target.value)) }}
          >
            <option value="">{t('fallback.off')}</option>
            {state.routes.map(route => <option key={routeValue(route)} value={routeValue(route)} title={routeFull(route)}>{routeShort(route)}</option>)}
          </select>
        </Tooltip>
        {draft.fallbackProvider !== ''
          ? (
            <EffortSelect
              label={t('fallback.effort')} route={fallbackRoute ?? undefined} value={draft.fallbackReasoningEffort}
              onChange={controller.setFallbackEffort}
              defaultLabel={t('effort.default')} defaultHoverLabel={t('effort.defaultHover')} defaultHoverPlainLabel={t('effort.defaultHoverPlain')} noneLabel={t('effort.none')} staleTitle={t('list.unavailable')}
            />
            )
          : null}
      </div>
      <div style={{ ...fieldRowStyle, flexDirection: 'column', gap: 0, padding: 0, border: 'none' }}>
        <button
          type="button" style={{ ...foldButtonStyle, width: '100%', padding: '12px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' }} aria-expanded={advancedOpen}
          onClick={() => { setAdvancedOpen(!advancedOpen) }}
        >
          {t('advanced.title')}
          <span style={{ flex: 1 }} />
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {advancedOpen
          ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <AdvancedToggle title={t('advanced.respectExplicit')} help={t('advanced.respectExplicitHelp')} checked={draft.respectExplicit} onChange={controller.setRespectExplicit} />
              <AdvancedToggle title={t('advanced.showNotice')} help={t('advanced.showNoticeHelp')} checked={draft.showNotice} onChange={controller.setShowNotice} />
              <AdvancedToggle title={t('advanced.pinForkChildren')} help={t('advanced.pinForkChildrenHelp')} checked={draft.pinForkChildren} onChange={controller.setPinForkChildren} />
              <AdvancedToggle title={t('advanced.failOpen')} help={t('advanced.failOpenHelp')} checked={draft.failOpen} onChange={controller.setFailOpen} />
              <AdvancedToggle title={t('advanced.autoRoute')} help={t('advanced.autoRouteHelp')} checked={draft.autoRoute} onChange={controller.setAutoRoute} />
              <div style={advancedRowStyle}>
                <span style={advancedTitleStyle}>{t('advanced.cooldownMs')}</span>
                <Info label={t('advanced.cooldownMsHelp')} text={t('advanced.cooldownMsHelp')} delayMs={400} />
                <span style={{ flex: 1 }} />
                <input
                  className={`dsmp-input${state.cooldownInvalid ? ' dsmp-invalid' : ''}`}
                  style={{ ...inputStyle, height: 32, width: 'auto', minWidth: 0 }}
                  defaultValue={String(draft.cooldownMs)}
                  inputMode="numeric"
                  aria-label={t('advanced.cooldownMs')}
                  onChange={event => { controller.setCooldownMs(event.target.value) }}
                />
              </div>
              {state.cooldownInvalid ? <p style={invalidStyle}>{t('advanced.cooldownInvalid')}</p> : null}
            </div>
            )
          : null}
      </div>
      {state.structural.map(message => <p key={message} style={invalidStyle}>{t('invalid.structural').replace('{message}', message.replace('dsh-subagent-plus: ', ''))}</p>)}
      {state.degraded.map(message => <p key={message} style={statusTextStyle('warn')}>{t('invalid.degraded').replace('{message}', message.replace('dsh-subagent-plus: ', ''))}</p>)}

      <footer style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          style={saveButtonStyle(!dirty || blocked || state.saving)}
          disabled={!dirty || blocked || state.saving}
          onClick={() => { void controller.save() }}
        >
          {state.saving ? t('action.saving') : t('action.save')}
        </button>
        {state.saved ? <span style={statusTextStyle('success')}>{t('action.saved')}</span> : null}
        {state.saveFailed ? <span style={statusTextStyle('error')}>{t('action.failed')}</span> : null}
        {state.conflict ? <span style={statusTextStyle('warn')}>{t('action.conflict')}</span> : null}
      </footer>
    </>
  )
}

/** One advanced row: single compact line — title + hover ⓘ left, green switch right;
 *  the explanation lives only in the ⓘ tooltip. */
function AdvancedToggle(props: { title: string; help: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div style={advancedRowStyle}>
      <span style={advancedTitleStyle}>{props.title}</span>
      <Info label={props.help} text={props.help} delayMs={400} />
      <span style={{ flex: 1 }} />
      <Switch checked={props.checked} onChange={props.onChange} label={props.title} />
    </div>
  )
}

function routeFromValue(state: SettingsUiState, value: string): RouteOption | null {
  if (value === '') return null
  const [provider, model] = value.split('\0')
  return state.routes.find(route => route.provider === provider && route.model === model) ?? null
}

/** Bind factory closing over the controller, mirroring the badge registration. */
export function bindSettingsSection(controller: SettingsSectionController) {
  return function BoundSettingsSection(props: PropsLocale<typeof NS>) {
    return <SettingsSection {...props} controller={controller} />
  }
}
