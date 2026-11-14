/**
 * The plugin's settings section: one model card whose bottom row carries the
 * assignment strategy, a fallback row, and an advanced fold (no in-page
 * switches — ADR 0005: the Plugins page toggle is the only off entrance).
 * Every edit lands in a local draft and one Save
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
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import { LimitsBlock } from './official-sections.tsx'
import type { OfficialLimitsController } from './official-surfaces.js'
import { kbStatusOf, KB_AS_OF } from '../capability-scoring.js'
import { benchRouteLabelsOf, kbVisibilityOf, sBandGapOf } from './badge-logic.ts'
import { NOISE_BAND } from '../strategy.js'
import { routeId } from '../pin.js'
import { isValidKeyword, MAX_NAME_MAP_ENTRIES, routeKey } from '../strategy.js'
import type { UnifiedSaveController } from './unified-save.js'
import { anyFieldDirty, buildResearchPackage, matchOverrideRoute, type RouteOption, type SettingsSectionController, type SettingsUiState } from './settings-controller.ts'
import { effortDefaultLabel, effortOptions, listedRoutesOf } from './settings-controller.ts'
import { NS } from './locales.ts'
import {
  nameMapRowStyle,
  nameInputStyle,
  chipTriggerStyle,
  pendingBadgeStyle,
  resetButtonStyle,
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

const routeValue: (route: { provider: string; model: string }) => string = routeKey

/** Short closed-box label (the browser-plus translate pattern): the select
 *  stays compact; the full route rides the hover tooltip and the option title. */
const routeShort = (route: { providerName: string; modelName: string }): string =>
  `${route.providerName} · ${route.modelName}`

/** Full route text for hover tooltips and option titles. */
const routeFull = (route: { providerName: string; modelName: string; provider: string; model: string }): string =>
  `${route.providerName} · ${routeId(route)} — ${route.modelName}`

/** Hover ⓘ: the dsh-websearch pattern — Tooltip wraps a borderless help-cursor anchor. */
/** Shared hover ⓘ (V3): also used by the limits block — one implementation,
 *  one infoButtonStyle. */
export function Info({ label, text, delayMs }: { label: string; text: string; delayMs: number }) {
  return (
    <Tooltip label={text} side="bottom" delayMs={delayMs} maxWidth={360} portal>
      <button type="button" aria-label={label} style={infoButtonStyle}>
        <QuestionIcon />
      </button>
    </Tooltip>
  )
}

/** Hover/click "×" anchor of a by-name mapping row revealing its single
 *  remove action — the IndexActionsCell popover pattern minus the moves a mapping
 *  row never has (mapping order carries no meaning). */
/** One-shot button feedback (V2, ADR 0016 UX note): the button itself swaps
 *  its label and pulses (`.dsmp-flash`) for a short window, then reverts —
 *  success is an event on the action source, not a paragraph below it. The
 *  timer clears on unmount or when a newer flash replaces it. */
function useActionFlash(durationMs = 2000): { label: string | undefined; flash: (label: string) => void } {
  const [label, setLabel] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const flash = (text: string): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    setLabel(text)
    timer.current = setTimeout(() => { timer.current = null; setLabel(undefined) }, durationMs)
  }
  return { label, flash }
}

function RemoveMenu(props: { label: string; trigger: React.ReactNode; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement | null>(null)
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
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => { setOpen(true) }}
      onMouseLeave={() => { setOpen(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
    >
      <button type="button" className="dsmp-hover" style={chipTriggerStyle} aria-haspopup="menu" aria-expanded={open} aria-label={props.label} onClick={() => { setOpen(true) }}>{props.trigger}</button>
      {open
        ? (
          <span role="menu" aria-label={props.label} style={rowPopupStyle}>
            <button type="button" role="menuitem" className="dsmp-pop-btn" style={{ ...rowPopupButtonStyle, color: 'var(--dsw-alias-state-error-primary)' }} onClick={() => { setOpen(false); props.onRemove() }}>{props.label}</button>
          </span>
          )
        : null}
    </span>
  )
}

/** Per-row actions for a CANDIDATE row, anchored on the leading index chip
 *  (I2, matching the by-name rows' chip-anchor convention — ADR 0015 d3):
 *  hovering (or clicking) the number reveals 上移/下移/删除, boundary rows
 *  never rendering a dead action; the model name stays a plain single line. */
function IndexActionsCell(props: {
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
  // A click PINS the popup open (hover alone already opens it); pointer-down
  // anywhere else closes it.
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
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => { setOpen(true) }}
      onMouseLeave={() => { setOpen(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
    >
      <button
        type="button"
        className="dsmp-hover"
        style={chipTriggerStyle}
        title={props.popupLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.popupLabel}
        onClick={() => { setOpen(true) }}
      ><span style={indexChipStyle}>{props.index + 1}</span></button>
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
  disabled?: boolean
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
      disabled={!hasEfforts || props.disabled === true}
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

/** The 36×20 green-when-on switch (advanced rows). */
function Switch({ checked, onChange, label, title, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className="dsmp-switch"
      style={{ ...switchStyle(checked), ...(disabled ? { opacity: 0.45, cursor: 'default' } : {}) }}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked) }}
    >
      <span style={switchThumbStyle(checked)} />
    </button>
  )
}

/** Presentation component; every action is a controller call, every string a locale key.
 *  The page shell (header, merged limits+strategy card, single footer) renders
 *  while any section is servable: the own-namespace branch only
 *  gates the strategy half of the merged card, never the limits block (T7 — no
 *  deadlock while the official page is hidden). */
export function SettingsSection(props: PropsLocale<typeof NS> & { controller: SettingsSectionController; limits: OfficialLimitsController; save: UnifiedSaveController }) {
  const { t, controller, save } = props
  const state: SettingsUiState = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const limitsState = useSyncExternalStore(props.limits.subscribe, props.limits.snapshot)
  const saveState = useSyncExternalStore(save.subscribe, save.snapshot)
  const limitsDirty = limitsState.value !== undefined && limitsState.draft !== undefined
    && JSON.stringify(limitsState.value) !== JSON.stringify(limitsState.draft)
  const ownBlocked = state.structural.length > 0 || state.degraded.length > 0 || state.cooldownInvalid
  const ownDirty = state.value !== undefined && state.draft !== undefined
    && JSON.stringify(state.value) !== JSON.stringify(state.draft)
  const ownReady = state.status === 'ready' && !state.valueInvalid && state.draft !== undefined
  const anyDirty = limitsDirty || ownDirty
  const anyBlocked = limitsState.invalid || ownBlocked
  const sectionTitle = (key: string): string => key === 'limits' ? t('takeover.limitsTitle') : t('title')
  return (
    <div data-dsmp-settings style={rootStyle}>
      <style>{settingsCss}</style>
      <header>
        <div style={pageHeaderRowStyle}>
          <h3 style={pageHeadingStyle}>{t('title')}</h3>
        </div>
        <p style={pageDescriptionStyle}>{t('description')}</p>
      </header>
      {state.catalogFailed ? <p style={invalidStyle}>{t('status.catalogFailed')}</p> : null}
      <section style={cardStyle} aria-labelledby="dsmp-limits">
        <LimitsBlock dirty={limitsDirty} state={limitsState} controller={props.limits} t={t} />
        <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.status === 'unavailable'
            ? <p style={invalidStyle}>{t('status.unavailable')}</p>
            : state.valueInvalid
              ? <p style={invalidStyle}>{t('status.valueInvalid')}</p>
              : state.draft === undefined
                ? <p style={hintStyle}>…</p>
                : <EditorRoutes state={state} controller={controller} t={t} />}
        </div>
      </section>
      {ownReady ? <EditorBelow state={state} controller={controller} t={t} /> : null}
      <footer style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={saveButtonStyle(!anyDirty || anyBlocked || saveState.saving)}
          disabled={!anyDirty || anyBlocked || saveState.saving}
          onClick={() => { void save.save() }}
        >
          {saveState.saving ? t('action.saving') : t('action.save')}
        </button>
        {saveState.saved ? <span style={statusTextStyle('success')}>{t('action.saved')}</span> : null}
        {saveState.blockedAt !== undefined ? <span style={statusTextStyle('error')}>{t('save.blockedAt').replace('{section}', sectionTitle(saveState.blockedAt))}</span> : null}
        {saveState.failedAt !== undefined ? <span style={statusTextStyle('error')}>{t('save.failedAt').replace('{section}', sectionTitle(saveState.failedAt))}</span> : null}
        {saveState.conflictAt !== undefined ? <span style={statusTextStyle('warn')}>{t('save.conflictAt').replace('{section}', sectionTitle(saveState.conflictAt))}</span> : null}
      </footer>
    </div>
  )
}

type EditorProps = {
  state: SettingsUiState
  controller: SettingsSectionController
  t: PropsLocale<typeof NS>['t']
}

/** The strategy half of the merged card: the candidate/pinned header row,
 *  the route list, the add row, and the strategy row. No card wrapper — the
 *  merged card in SettingsSection owns the single border. */
function EditorRoutes(props: EditorProps) {
  const { state, controller, t } = props
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | undefined>(undefined)
  const exportFlash = useActionFlash()
  const importFlash = useActionFlash()
  const resetFlash = useActionFlash()
  const draft = state.draft
  if (draft === undefined) return null
  const listed = listedRoutesOf(state)
  // KB visibility of the candidate list (F2): unknown chips on the rows, the
  // summary line, and the estimatedAll mutual exclusion all read one aggregate.
  const kbVisibility = kbVisibilityOf(listed, draft.capabilityOverrides ?? [])
  // Bench candidates (G3): listed routes no effective row references — the
  // middle failover tier, surfaced so an idle candidate never reads as a bug.
  const benchLabels = benchRouteLabelsOf(listed, state.effectiveNameMap)
  // Noise-band visibility (H4): a sub-band top-two S gap means the listing
  // order decided the review family — say so before it reads as a bug.
  const bandGap = sBandGapOf(listed, draft.capabilityOverrides ?? [])
  // Team ⓘ composition (I1): the base help plus the two model-state
  // advisories (formerly inline paragraphs) — joined with '；' because the
  // host tooltip's whitespace handling is not guaranteed to break lines.
  const bynameInfoText = [
    t('byname.help'),
    ...(kbVisibility.estimatedAll ? [t('byname.estimatedAll')] : []),
    ...(bandGap !== undefined ? [t('byname.bandHint').replace('{gap}', bandGap.toFixed(4)).replace('{band}', String(NOISE_BAND))] : []),
  ].join('；')
  // ADR 0007 decision 3: under the pinned strategy the candidate list is not
  // shown, so the mapping's route pickers lock instead of sourcing a list the
  // user cannot see or edit.
  const byNameLocked = draft.strategy === 'pinned'
  const todayText = (): string => {
    // Local calendar date (G-7): toISOString drifts a day early for UTC+8 evenings.
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  const exportResearch = (): void => {
    // Full-catalogue scope (ADR 0016 d3, Z8): evaluations are a durable,
    // configuration-independent corpus — the research package covers every
    // model the host catalogue serves, not just the current candidate list, so
    // an imported score applies whenever its model later joins the candidates.
    const candidates = state.routes.map(route => {
      const match = matchOverrideRoute(route, state.routes, draft.priority)
      return { provider: route.provider, model: route.model, match: match === 'route-miss' ? 'none' as const : match as 'candidate' | 'kb' | 'none' }
    })
    const pkg = buildResearchPackage(candidates, todayText())
    const text = JSON.stringify(pkg, null, 2)
    const fallbackToPanel = (): void => {
      // Clipboard unavailable (http remote) or rejected: open the import panel
      // prefilled with the package so the user can copy it manually.
      setImportText(text)
      setImportOpen(true)
      setImportError(t('byname.research.clipboardFallback'))
    }
    if (navigator.clipboard?.writeText === undefined) {
      fallbackToPanel()
      return
    }
    void navigator.clipboard.writeText(text)
      .then(() => { exportFlash.flash(t('byname.research.copied')) })
      .catch(fallbackToPanel)
  }
  const applyImport = (): void => {
    setImportError(undefined)
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      setImportError(t('byname.research.notArray'))
      return
    }
    try {
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'prompt' in (parsed as Record<string, unknown>)) {
        // The user pasted the export package itself — a friendly pointer beats
        // a raw "not an array" error.
        setImportError(t('byname.research.packagePasted'))
        return
      }
      const rows = Array.isArray(parsed) ? parsed : undefined
      if (rows === undefined) {
        setImportError(t('byname.research.notArray'))
        return
      }
      const result = controller.importCapabilityOverrides(rows as never)
      if (result.kind === 'rejected') {
        setImportError(t('byname.research.rejected').replace('{reasons}', result.reasons.join('；')))
        return
      }
      importFlash.flash(result.mergedDuplicates.length > 0
        ? t('byname.research.importedMerged').replace('{n}', String(result.rows.length)).replace('{m}', String(result.mergedDuplicates.length))
        : t('byname.research.imported').replace('{n}', String(result.rows.length)))
      setImportOpen(false)
    } catch (error) {
      setImportError(String(error))
    }
  }
  const pinnedRoute = state.routes.find(route => route.provider === draft.provider && route.model === draft.model) ?? null
  const fallbackRoute = state.routes.find(route => route.provider === draft.fallbackProvider && route.model === draft.fallbackModel) ?? null
  const pinnedHover = pinnedRoute === null && draft.provider === ''
    ? undefined
    : pinnedRoute !== null
      ? routeFull(pinnedRoute)
      : routeId(draft)

  return (
    <>
        <div style={cardHeaderRowStyle}>
          <h4 id="dsmp-routes" style={cardHeadingStyle}>
            {draft.strategy === 'pinned' ? t('strategy.pinnedRoute') : t('list.title')}
          </h4>
          <Info
            label={draft.strategy === 'pinned' ? t('strategy.pinnedRouteHelp') : t('list.help')}
            text={draft.strategy === 'pinned' ? t('strategy.pinnedRouteHelp') : t('list.help')}
            delayMs={400}
          />
          {anyFieldDirty(state.value, state.draft, ['priority', 'strategy', 'provider', 'model', 'reasoningEffort'])
            ? <span style={pendingBadgeStyle}>{t('common.pending')}</span>
            : null}
          <span style={{ flex: 1 }} />
          {draft.strategy === 'pinned'
            ? (
              <>
                <Tooltip label={pinnedHover ?? t('strategy.pinnedPlaceholder')} side="bottom" delayMs={200} maxWidth={360} portal>
                  <select
                    className="dsmp-select"
                    style={routeSelectStyle}
                    value={pinnedRoute === null && draft.provider === '' ? '' : routeValue(pinnedRoute !== null ? pinnedRoute : draft)}
                    aria-label={t('strategy.pinnedRoute')}
                    title={pinnedHover ?? t('strategy.pinnedPlaceholder')}
                    onChange={event => { controller.setPinnedRoute(routeFromValue(state.routes, event.target.value)) }}
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
                  <div key={routeValue(route)} className="dsmp-hover" style={listRowStyle}>
                    {/* I2: the actions ride the index chip (the by-name rows'
                        convention) — hover the number for 上移/下移/删除. */}
                    <IndexActionsCell
                      popupLabel={`${t('list.rowActions')} ${routeId(route)}`}
                      index={index} count={listed.length}
                      moveUp={t('list.moveUp')} moveDown={t('list.moveDown')} remove={t('list.remove')}
                      onMove={delta => { controller.moveRoute(index, delta) }}
                      onRemove={() => { controller.removeRoute(index) }}
                    />
                    {/* F2: an unknown candidate carries a visible chip — the
                        excluded side of a mixed list is otherwise invisible
                        (the audit's silent-zero-rows failure). */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }} title={routeId(route)}>
                      <span style={routeNameStyle}>{`${route.providerName} · ${route.modelName}${route.available ? '' : ` · ${t('list.unavailable')}`}`}</span>
                      {kbStatusOf(route.model, draft.capabilityOverrides ?? [], undefined, route.provider) === 'unknown'
                        ? (
                          <span
                            style={pendingBadgeStyle}
                            title={t('byname.kbUnknownChipTitle').replace('{date}', KB_AS_OF)}
                          >{t('byname.kbUnknownChip')}</span>
                        )
                        : null}
                    </span>
                    {route.available && route.efforts !== undefined && route.efforts.length > 0
                      ? (
                        <EffortSelect
                          label={`${t('strategy.effort')} ${routeId(route)}`} route={route}
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
                    const route = routeFromValue(state.routes, event.target.value)
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'nowrap' }}>
            <span style={cardHeadingStyle}>{t('strategy.label')}</span>
            <Info label={t('strategy.help')} text={t('strategy.help')} delayMs={400} />
          </span>
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

        {/* Role-keyword mapping (ADR 0008 + 0014): teammates whose names contain
            a row's keyword run that row's route (longest keyword wins). Under
            defaults mode the rows derive from the candidate list and adapt
            live (ADR 0014 d2); the first edit materialises them into ordinary
            custom rows. Pinned locks route pickers (the R1 mirror). */}
        <div style={fieldRowStyle}>
          <div style={cardHeaderRowStyle}>
            <h4 id="dsmp-byname" style={cardHeadingStyle}>{t('byname.title')}</h4>
            <Info label={t('byname.help')} text={bynameInfoText} delayMs={400} />
            {state.value !== undefined && state.draft !== undefined && (JSON.stringify(state.value.nameMap) !== JSON.stringify(state.draft.nameMap) || state.value.nameMapDefaults !== state.draft.nameMapDefaults || JSON.stringify(state.value.capabilityOverrides) !== JSON.stringify(state.draft.capabilityOverrides))
              ? <span style={pendingBadgeStyle}>{t('common.pending')}</span>
              : null}
            <span style={{ flex: 1 }} />
            {/* ADR 0015 d2 + 2026-11-14 fix: one persistent control in both
                modes, styled as the plain action button it is (the select style
                made it look like a dropdown). In pure defaults mode there is
                nothing to reset — the button disables with an explanatory
                title instead of firing a silent no-op; with stored rows being
                ignored (degraded) it stays armed. */}
            {/* ADR 0015 d2 + 2026-11-14 fix: one persistent control in both
                modes, styled as the plain action button it is (the select style
                made it look like a dropdown). In pure defaults mode there is
                nothing to reset — the button disables with an explanatory
                title instead of firing a silent no-op; with stored rows being
                ignored (degraded) it stays armed. Disabled styling is an
                INLINE spread (ADR 0016 d4): CSS classes lose to inline cursor. */}
            {!byNameLocked
              ? <button
                type="button"
                className={resetFlash.label === undefined ? 'dsmp-hover' : 'dsmp-hover dsmp-flash'}
                style={{ ...resetButtonStyle, ...(draft.nameMapDefaults && draft.nameMap.length === 0 ? { opacity: 0.45, cursor: 'default' } : {}) }}
                disabled={draft.nameMapDefaults && draft.nameMap.length === 0}
                title={draft.nameMapDefaults && draft.nameMap.length === 0 ? t('byname.resetIdle') : t('byname.resetHint')}
                aria-label={t('byname.reset')}
                onClick={() => { controller.resetNameMapDefaults(); resetFlash.flash(t('byname.resetDone')) }}
              >{resetFlash.label ?? t('byname.reset')}</button>
              : null}
            {!byNameLocked
              ? (
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  <button type="button" className={exportFlash.label === undefined ? 'dsmp-hover' : 'dsmp-hover dsmp-flash'} style={resetButtonStyle} title={t('byname.research.hint').replace('{date}', String(KB_AS_OF))} onClick={() => { void exportResearch() }}>{exportFlash.label ?? t('byname.research.export')}</button>
                  <button type="button" className={importFlash.label === undefined ? 'dsmp-hover' : 'dsmp-hover dsmp-flash'} style={resetButtonStyle} title={t('byname.research.importTitle')} onClick={() => { setImportOpen(!importOpen); setImportError(undefined) }}>{importFlash.label ?? t('byname.research.import')}</button>
                </span>
              )
              : null}
          </div>
          {byNameLocked ? <p style={hintStyle}>{t('byname.pinnedHint')}</p> : null}
          {!byNameLocked && draft.nameMapDefaults
            ? <p style={hintStyle}>{`${listed.length > 0 ? `${t('byname.defaultsHint')}${t('common.previewSuffix')}` : t('byname.defaultsEmpty')} ${t('byname.research.sourceKb').replace('{date}', KB_AS_OF)}`}</p>
            : null}
          {!byNameLocked && draft.nameMapDefaults && kbVisibility.unknownModels.length > 0
            ? <p style={hintStyle}>{t('byname.kbUnknownSummary').replace('{n}', String(kbVisibility.unknownModels.length))}</p>
            : null}
          {!byNameLocked && benchLabels.length > 0
            ? <p style={hintStyle}>{t('byname.benchHint').replace('{n}', String(benchLabels.length))}</p>
            : null}
          {!byNameLocked && !draft.nameMapDefaults && draft.nameMap.length > 0
            ? <p style={hintStyle}>{t('byname.customHint')}</p>
            : null}
          {importOpen
            ? (
              <div style={{ ...fieldRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <span style={cardHeadingStyle}>{t('byname.research.importTitle')}</span>
                <textarea
                  className="dsmp-input"
                  style={{ ...nameInputStyle, width: '100%', minWidth: 0, height: 120 }}
                  value={importText}
                  placeholder={t('byname.research.placeholder')}
                  aria-label={t('byname.research.importTitle')}
                  onChange={event => { setImportText(event.target.value) }}
                />
                {importError !== undefined ? <p style={statusTextStyle('error')}>{importError}</p> : null}
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  <button type="button" className="dsmp-hover" style={{ ...resetButtonStyle, opacity: 0.9 }} onClick={applyImport}>{t('byname.research.apply')}</button>
                  <button type="button" className="dsmp-hover" style={{ ...resetButtonStyle, opacity: 0.9 }} onClick={() => { setImportOpen(false); setImportError(undefined) }}>{t('byname.research.cancel')}</button>
                </span>
              </div>
            )
            : null}
          {(draft.capabilityOverrides?.length ?? 0) > 0 ? <p style={hintStyle}>{t('byname.research.calibration')}</p> : null}
          {(draft.capabilityOverrides?.length ?? 0) > 0
            ? (
              <div style={{ ...fieldRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <span style={cardHeadingStyle}>{t('byname.research.source')}</span>
                  <button type="button" className="dsmp-hover" style={{ ...resetButtonStyle, opacity: 0.85, height: 20 }} title={t('byname.research.cleared')} onClick={() => { controller.clearCapabilityOverrides() }}>{t('byname.research.clear')}</button>
                </span>
                {draft.capabilityOverrides.map((row, index) => (
                  <div key={`${(row.provider ?? '').trim()}\0${row.model}\0${index}`} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <span style={hintStyle}>{(row.provider ?? '').trim() !== '' ? `${(row.provider ?? '').trim()} · ${row.model}` : row.model}</span>
                    <span style={pendingBadgeStyle}>{(() => {
                      const match = matchOverrideRoute(row, state.routes, draft.priority)
                      if (match === 'route-miss') return t('byname.research.routeMiss')
                      if (match === 'candidate') return t('byname.research.matchCandidate')
                      if (match === 'kb') return t('byname.research.matchKb')
                      return t('byname.research.matchNone')
                    })()}</span>
                    <span style={hintStyle}>{[row.overall, row.coding, row.webdev, row.agentic].filter(score => score !== undefined).join(' / ')} · {row.asOf}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="dsmp-hover" style={{ ...resetButtonStyle, opacity: 0.85, height: 20 }} aria-label={t('byname.research.remove')} onClick={() => { controller.removeCapabilityOverride(index) }}>×</button>
                  </div>
                ))}
              </div>
            )
            : null}
          {state.advisory.length > 0 ? <p style={hintStyle}>{state.advisory.join('；')}</p> : null}
          {state.effectiveNameMap.length === 0
            ? (byNameLocked && draft.nameMapDefaults
                ? <p style={hintStyle}>{t('byname.defaultsDormant')}</p>
                : !byNameLocked && draft.nameMapDefaults ? null : <p style={hintStyle}>{t('byname.empty')}</p>)
            : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {state.effectiveNameMap.map((row, index) => {
                  const listedHit = listed.find(candidate =>
                    candidate.provider === row.provider && candidate.model === row.model) ?? null
                  const catalogHit = state.routes.find(candidate =>
                    candidate.provider === row.provider && candidate.model === row.model) ?? null
                  const storedRows = draft.nameMapDefaults ? state.effectiveNameMap : draft.nameMap
                  const duplicate = row.name !== '' && storedRows.some((other, otherIndex) =>
                    otherIndex !== index && other.name === row.name)
                  const nameInvalid = duplicate || !isValidKeyword(row.name)
                  const routeIncomplete = row.provider === '' || row.model === ''
                  const dangling = !routeIncomplete && listedHit === null
                  const currentLabel = listedHit !== null
                    ? routeShort(listedHit)
                    : routeIncomplete ? t('byname.routeInvalid') : `${row.provider} · ${row.model}`
                  const routeTitle = listedHit !== null
                    ? routeFull(listedHit) + (kbStatusOf(listedHit.model, draft.capabilityOverrides ?? [], undefined, listedHit.provider) === 'unknown' ? ` · ${t('byname.kbUnknown').replace('{date}', KB_AS_OF)}` : '')
                    : routeIncomplete ? t('byname.routeInvalid')
                      : catalogHit === null ? t('list.unavailable') : t('byname.routeNotListed')
                  return (
                    <div key={`${row.name}\0${index}`} className="dsmp-hover" style={nameMapRowStyle}>
                      {/* Delete rides the index chip hover (ADR 0015 d3): the
                          popup anchors on the FIRST track and expands right —
                          the old trailing × popup overflowed the card edge. */}
                      <RemoveMenu label={t('byname.remove')} trigger={<span style={indexChipStyle}>{index + 1}</span>} onRemove={() => { controller.removeNameRow(index) }} />
                      <input
                        className={`dsmp-input${nameInvalid ? ' dsmp-invalid' : ''}`}
                        style={nameInputStyle}
                        value={row.name}
                        placeholder={t('byname.namePlaceholder')}
                        aria-label={t('byname.name')}
                        title={nameInvalid ? t('byname.nameInvalid') : t('byname.name')}
                        onChange={event => { controller.setNameRowName(index, event.target.value) }}
                      />
                      <select
                        className="dsmp-select"
                        style={{ ...routeSelectStyle, width: '100%' }}
                        value={listedHit !== null ? routeValue(listedHit) : ''}
                        disabled={byNameLocked}
                        aria-label={t('byname.title')}
                        title={routeTitle}
                        onChange={event => {
                          const next = routeFromValue(listed, event.target.value)
                          if (next !== null) controller.setNameRowRoute(index, next)
                        }}
                      >
                        {/* Leading display option only for incomplete/dangling
                            rows — a listed hit renders identically among the
                            options below, and duplicating it showed two
                            same-named entries (the Q4 report). */}
                        {listedHit === null ? <option value="">{currentLabel}</option> : null}
                        {listed.map(candidate => (
                          <option key={routeValue(candidate)} value={routeValue(candidate)} title={routeFull(candidate) + (kbStatusOf(candidate.model, draft.capabilityOverrides ?? [], undefined, candidate.provider) === 'unknown' ? ` · ${t('byname.kbUnknownChip')}` : '')}>{routeShort(candidate)}</option>
                        ))}
                      </select>
                      {/* Always rendered: an unusable route renders the select's
                          own disabled placeholder, so every row keeps exactly
                          four children on the four tracks (ADR 0015 d3). */}
                      <EffortSelect
                        label={`${t('strategy.effort')} ${listedHit !== null ? routeId(listedHit) : t('byname.name')}`} route={listedHit !== null ? catalogHit ?? undefined : undefined}
                        value={listedHit !== null ? row.reasoningEffort : ''}
                        onChange={value => { controller.setNameRowEffort(index, value) }}
                        disabled={byNameLocked}
                        defaultLabel={t('effort.default')} defaultHoverLabel={t('effort.defaultHover')} defaultHoverPlainLabel={t('effort.defaultHoverPlain')} noneLabel={t('effort.none')} staleTitle={t('list.unavailable')}
                      />
                    </div>
                  )
                })}
              </div>
              )}
          
          <div style={{ ...fieldRowStyle, gap: 8, flexDirection: 'row', alignItems: 'center' }}>
            <span style={cardHeadingStyle}>{t('byname.add')}</span>
            <span style={{ flex: 1 }} />
            <select
              className="dsmp-select"
              style={routeSelectStyle}
              value=""
              disabled={byNameLocked || state.effectiveNameMap.length >= MAX_NAME_MAP_ENTRIES}
              aria-label={t('byname.add')}
              onChange={event => {
                const route = routeFromValue(listed, event.target.value)
                if (route !== null) controller.addNameRow(route)
              }}
            >
              <option value="">{
                byNameLocked ? t('byname.pinnedHint')
                  : draft.nameMap.length >= MAX_NAME_MAP_ENTRIES ? t('byname.max')
                    : listed.length === 0 ? t('byname.emptyList')
                      : t('byname.addPlaceholder')
              }</option>
              {listed.map(route => <option key={routeValue(route)} value={routeValue(route)} title={routeFull(route) + (kbStatusOf(route.model, draft.capabilityOverrides ?? [], undefined, route.provider) === 'unknown' ? ` · ${t('byname.kbUnknownChip')}` : '')}>{routeShort(route)}</option>)}
            </select>
          </div>
        </div>
        <div style={{ ...fieldRowStyle, gap: 8, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'nowrap' }}>
            <span style={cardHeadingStyle}>{t('fallback.title')}</span>
            <Info label={t('fallback.help')} text={t('fallback.help')} delayMs={400} />
            {anyFieldDirty(state.value, state.draft, ['fallbackProvider', 'fallbackModel', 'fallbackReasoningEffort'])
              ? <span style={pendingBadgeStyle}>{t('common.pending')}</span>
              : null}
          </span>
          <span style={{ flex: 1 }} />
          <Tooltip label={fallbackRoute === null ? t('fallback.off') : routeFull(fallbackRoute)} side="bottom" delayMs={200} maxWidth={360} portal>
            <select
              className="dsmp-select"
              style={routeSelectStyle}
              value={fallbackRoute === null ? '' : routeValue(fallbackRoute)}
              aria-label={t('fallback.title')}
              title={fallbackRoute === null ? t('fallback.off') : routeFull(fallbackRoute)}
              onChange={event => { controller.setFallbackRoute(routeFromValue(state.routes, event.target.value)) }}
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

    </>
  )
}


/** The merged card's page-level siblings: the advanced fold and the
 *  validation lines. */
function EditorBelow({ state, controller, t }: EditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const draft = state.draft
  if (draft === undefined) return null
  return (
    <>
      <div style={{ ...fieldRowStyle, flexDirection: 'column', gap: 0, padding: 0, border: 'none' }}>
        <button
          type="button" style={{ ...foldButtonStyle, width: '100%', padding: '12px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' }} aria-expanded={advancedOpen}
          onClick={() => { setAdvancedOpen(!advancedOpen) }}
        >
          {t('advanced.title')}
          {anyFieldDirty(state.value, state.draft, ['respectExplicit', 'showNotice', 'pinForkChildren', 'failOpen', 'cooldownMs'])
            ? <span style={pendingBadgeStyle}>{t('common.pending')}</span>
            : null}
          <span style={{ flex: 1 }} />
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {advancedOpen
          ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <AdvancedToggle title={t('advanced.respectExplicit')} help={t('advanced.respectExplicitHelp')} checked={draft.respectExplicit} onChange={controller.setRespectExplicit} disabled={draft.strategy === 'pinned'} />
              <AdvancedToggle title={t('advanced.showNotice')} help={t('advanced.showNoticeHelp')} checked={draft.showNotice} onChange={controller.setShowNotice} />
              <AdvancedToggle title={t('advanced.pinForkChildren')} help={t('advanced.pinForkChildrenHelp')} checked={draft.pinForkChildren} onChange={controller.setPinForkChildren} />
              <AdvancedToggle title={t('advanced.failOpen')} help={t('advanced.failOpenHelp')} checked={draft.failOpen} onChange={controller.setFailOpen} />
              <div style={advancedRowStyle}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'nowrap' }}>
                  <span style={advancedTitleStyle}>{t('advanced.cooldownMs')}</span>
                  <Info label={t('advanced.cooldownMsHelp')} text={t('advanced.cooldownMsHelp')} delayMs={400} />
                </span>
                <span style={{ flex: 1 }} />
                <input
                  className={`dsmp-input${state.cooldownInvalid ? ' dsmp-invalid' : ''}`}
                  style={{ ...inputStyle, width: 88, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                  defaultValue={String(draft.cooldownMs)}
                  inputMode="numeric"
                  aria-label={t('advanced.cooldownMs')}
                  onChange={event => { controller.setCooldownMs(event.target.value) }}
                />
              </div>
              {state.cooldownInvalid ? <p style={invalidStyle}>{t('advanced.cooldownInvalid')}</p> : null}
              {draft.strategy === 'pinned' && draft.fallbackProvider === '' && draft.nameMap.length === 0 ? <p style={hintStyle}>{t('advanced.cooldownInactive')}</p> : null}
            </div>
            )
          : null}
      </div>
      {state.structural.map(message => <p key={message} style={invalidStyle}>{t('invalid.structural').replace('{message}', message.replace('dsh-subagent-plus: ', ''))}</p>)}
      {state.degraded.map(message => <p key={message} style={statusTextStyle('warn')}>{t('invalid.degraded').replace('{message}', message.replace('dsh-subagent-plus: ', ''))}</p>)}
    </>
  )
}

/** One advanced row: single compact line — title + hover ⓘ left, green switch right;
 *  the explanation lives only in the ⓘ tooltip. */
function AdvancedToggle(props: { title: string; help: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div style={{ ...advancedRowStyle, ...(props.disabled ? { opacity: 0.55 } : {}) }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'nowrap' }}>
        <span style={advancedTitleStyle}>{props.title}</span>
        <Info label={props.help} text={props.help} delayMs={400} />
      </span>
      <span style={{ flex: 1 }} />
      <Switch checked={props.checked} onChange={props.onChange} label={props.title} disabled={props.disabled} />
    </div>
  )
}

function routeFromValue(source: readonly RouteOption[], value: string): RouteOption | null {
  const [provider, model] = value.split('\u0000')
  return source.find(route => route.provider === provider && route.model === model) ?? null
}

/** Bind factory closing over the controllers, mirroring the badge registration. */
export function bindSettingsSection(controller: SettingsSectionController, limits: OfficialLimitsController, save: UnifiedSaveController) {
  return function BoundSettingsSection(props: PropsLocale<typeof NS>) {
    return <SettingsSection {...props} controller={controller} limits={limits} save={save} />
  }
}
