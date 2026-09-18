// Capture mode (MEGALITH demo plan §6): the console state used for the
// screenshots and the video. Enabled by `?capture=1` on any route or by the
// toggle in the top bar; the choice persists in sessionStorage so it
// survives the Brigade <-> Operator <-> Spacecraft page loads.
//
// What capture mode does:
//
//  1. Hides everything labelled stub, debug, TODO or demo mode, and every
//     dev-only control. Components check `useCaptureStore` and skip these
//     elements entirely (not only via CSS), see CAPTURE_HIDES below.
//  2. Fixes a 1920x1080-safe layout: `[data-capture="1"]` on <html> pins the
//     Brigade rails to 300 / 380 px, removes the corner clip-paths, turns
//     off animations and transitions so a frame never catches a fade, and
//     forces the dark theme (`color-scheme: dark`).
//  3. Collapses the reasoning-trace pane by default (capture S1 wants it
//     collapsed; S5 opens it with one click).
import { create } from 'zustand'

export const CAPTURE_QUERY_PARAM = 'capture'
export const CAPTURE_STORAGE_KEY = 'megalith-capture'

/** Everything capture mode hides, by component. Kept as data so the test
 *  and the hand-back document the same list. */
export const CAPTURE_HIDES: ReadonlyArray<{ component: string; hides: string }> = [
  { component: 'ScenarioRail', hides: 'scenario library list (dev replay buttons)' },
  { component: 'EventFeed', hides: 'Flow tab (the scripted "LLM decision flow" animation is a placeholder, not engine output)' },
  { component: 'EventFeed', hides: 'raw JSON envelope under an expanded row' },
  { component: 'ReasoningPanel', hides: 'reset button (clears engine state)' },
  { component: 'CesiumGlobe / MapStage', hides: 'imagery-mode debug label ("Loading imagery", "Ion world imagery")' },
  { component: 'AorMap', hides: 'basemap switch (Imagery / Muted)' },
  { component: 'StressMode', hides: 'explanatory hint paragraph (the controls stay: F9 needs them)' },
  { component: 'Top bar', hides: 'nothing: page links stay so the capture session can move between Brigade, Spacecraft and Run; the toggle reads "REC" while on' },
  { component: 'BusHealthCard', hides: 'signal id and provenance footer' },
  { component: 'RunSummary', hides: 'raw trace ids next to each stage timing' },
]

type CaptureState = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  toggle: () => void
}

const hasWindow = () => typeof window !== 'undefined'

/** `?capture=1` wins; else the sessionStorage flag; else off. */
export function readInitialCapture(
  search: string = hasWindow() ? window.location.search : '',
): boolean {
  const params = new URLSearchParams(search)
  const fromQuery = params.get(CAPTURE_QUERY_PARAM)
  if (fromQuery !== null) {
    return fromQuery === '1' || fromQuery === 'true' || fromQuery === 'on'
  }
  if (!hasWindow()) return false
  try {
    return window.sessionStorage.getItem(CAPTURE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persist(enabled: boolean) {
  if (!hasWindow()) return
  try {
    if (enabled) {
      window.sessionStorage.setItem(CAPTURE_STORAGE_KEY, '1')
    } else {
      window.sessionStorage.removeItem(CAPTURE_STORAGE_KEY)
    }
  } catch {
    // Storage disabled: the flag lives for this page only.
  }
  document.documentElement.toggleAttribute('data-capture', enabled)
  if (enabled) document.documentElement.setAttribute('data-capture', '1')
}

export const useCaptureStore = create<CaptureState>()((set, get) => ({
  enabled: false,
  setEnabled: (enabled) => {
    persist(enabled)
    set({ enabled })
  },
  toggle: () => get().setEnabled(!get().enabled),
}))

/** Read the URL / storage once and apply it. Called by App on mount. */
export function initialiseCaptureMode(search?: string) {
  useCaptureStore.getState().setEnabled(readInitialCapture(search))
}

/** Appends `capture=1` to a same-origin path when capture mode is on. */
export function withCapture(path: string, enabled: boolean = useCaptureStore.getState().enabled): string {
  if (!enabled) return path
  return `${path}${path.includes('?') ? '&' : '?'}${CAPTURE_QUERY_PARAM}=1`
}
