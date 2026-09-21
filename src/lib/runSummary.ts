// Helpers behind the `/run` scorecard: the gateway's `/health` body, the
// last launched run, and a scenario id guessed from signal ids.
import { LAST_RUN_KEY, REPLAY_MAX_DELAY_S, REPLAY_SPEED } from './demoRuns'
import type { ReplayMarker } from '../types/canopy'

export type HealthSummary = {
  status: string
  /** LLM client class name the gateway reports, e.g. `OllamaClient`. */
  llm: string | null
  /** Plain-language provider derived from the class name. */
  provider: string
  kbEntries: number | null
  osintModel: string | null
}

export function providerFromClass(className: string | null): string {
  if (!className) return 'unknown'
  const lower = className.toLowerCase()
  if (lower.includes('stub')) return 'stub (functionality checks only)'
  if (lower.includes('ollama')) return 'local model via Ollama'
  if (lower.includes('anthropic')) return 'Anthropic API'
  if (lower.includes('openai')) return 'OpenAI API'
  return className
}

/** Map the gateway's `/health` body to the fields the scorecard shows. */
export function summariseHealth(body: unknown): HealthSummary {
  const record = (body ?? {}) as Record<string, unknown>
  const llm = typeof record.llm === 'string' ? record.llm : null
  const osint = (record.osint_cluster ?? {}) as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    llm,
    provider: providerFromClass(llm),
    kbEntries: typeof record.kb_entries === 'number' ? record.kb_entries : null,
    osintModel: typeof osint.model_name === 'string' ? osint.model_name : null,
  }
}

export type LastRun = {
  run: string
  stem: string
  startedAt: string
  /** The launcher's flight rate (1, 10, 60 or 600), or null for the storyboard's pacing. */
  flight: number | null
} | null

export function readLastRun(): LastRun {
  try {
    const raw = sessionStorage.getItem(LAST_RUN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { run?: unknown; stem?: unknown; startedAt?: unknown; flight?: unknown }
    if (typeof parsed.run !== 'string' || typeof parsed.stem !== 'string') return null
    return {
      run: parsed.run,
      stem: parsed.stem,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      flight: typeof parsed.flight === 'number' && parsed.flight > 0 ? parsed.flight : null,
    }
  } catch {
    return null
  }
}

const speedText = (speed: number) => `${Number.isInteger(speed) ? speed : speed.toFixed(1)}×`

/** The run's pacing in words (docs/MEGALITH-Flight-Plan.md §4, stage 4): the
 *  gateway's `replay` marker when the console has one (`speed 60× · no cap ·
 *  finished`), else what the launcher posted, else unknown. */
export function pacingLabel(marker: ReplayMarker | null | undefined, lastRun: LastRun): string {
  if (marker) {
    const cap = marker.max_delay_s === null ? 'no cap' : `gaps capped at ${marker.max_delay_s} s`
    return `speed ${speedText(marker.speed)} · ${cap} · ${marker.state}`
  }
  if (lastRun?.flight) return `flight ${speedText(lastRun.flight)} · no cap · posted by the launcher`
  if (lastRun) return `speed ${speedText(REPLAY_SPEED)} · gaps capped at ${REPLAY_MAX_DELAY_S} s · posted by the launcher`
  return 'unknown'
}

/** Scenario id guessed from signal ids (`heldout-link-margin-hostile-005`
 *  -> `heldout-link-margin-hostile`). */
export function scenarioIdFromSignals(ids: string[]): string | null {
  const first = ids.find((id) => /-\d+$/.test(id))
  return first ? first.replace(/-\d+$/, '') : null
}
