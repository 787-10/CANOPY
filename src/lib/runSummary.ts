// Helpers behind the `/run` scorecard: the gateway's `/health` body, the
// last launched run, and a scenario id guessed from signal ids.
import { LAST_RUN_KEY } from './demoRuns'

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

export type LastRun = { run: string; stem: string; startedAt: string } | null

export function readLastRun(): LastRun {
  try {
    const raw = sessionStorage.getItem(LAST_RUN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { run?: unknown; stem?: unknown; startedAt?: unknown }
    if (typeof parsed.run !== 'string' || typeof parsed.stem !== 'string') return null
    return {
      run: parsed.run,
      stem: parsed.stem,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null
  }
}

/** Scenario id guessed from signal ids (`heldout-link-margin-hostile-005`
 *  -> `heldout-link-margin-hostile`). */
export function scenarioIdFromSignals(ids: string[]): string | null {
  const first = ids.find((id) => /-\d+$/.test(id))
  return first ? first.replace(/-\d+$/, '') : null
}
