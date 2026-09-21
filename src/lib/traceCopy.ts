// Plain-language headlines for the reasoning trace. The engine's trace
// messages are terse key=value lines written for the log
// (`ui event updated: recommendation_created severity=medium revision=1`);
// the Reasoning page shows each one as a sentence an operator can act on,
// with the raw line kept underneath as the record. Pure over the trace so
// every shape has a unit test.
import { actionLabel } from './actionLabels'
import {
  domainLabel,
  gateReasonLabel,
  isVerdict,
  recoveryActionLabel,
  spacecraftDisplayName,
  verdictLabel,
} from './commanderLanguage'
import { anomalyKindLabel } from './reports'
import { targetLabel } from './targetLabel'
import type { Domain, ReasoningTrace, TraceStage } from '../types/canopy'

export type TraceCategory = {
  /** What the stage is, in words: `Attribution · red team`. */
  label: string
  /** The engine's own stage code, kept for the record: `attrib.redteam`. */
  code: string
}

export const TRACE_CATEGORY: Record<TraceStage, TraceCategory> = {
  fusion: { label: 'Fusion', code: 'fusion' },
  attrib_primary: { label: 'Attribution · primary', code: 'attrib.primary' },
  attrib_redteam: { label: 'Attribution · red team', code: 'attrib.redteam' },
  attrib_reconcile: { label: 'Attribution · reconcile', code: 'attrib.reconcile' },
  decide: { label: 'Decide', code: 'decide' },
  tools: { label: 'Tools', code: 'tools' },
  stress: { label: 'Stress mode', code: 'stress' },
}

export function traceCategory(stage: TraceStage): TraceCategory {
  return TRACE_CATEGORY[stage] ?? { label: stage, code: stage }
}

const pct = (raw: string | number | null | undefined): string | null => {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : null
}

const verdictWords = (raw: string): string =>
  isVerdict(raw) ? verdictLabel(raw) : raw.replaceAll('_', ' ')

const actorClause = (actor: string | null | undefined): string =>
  actor && actor !== 'None' && actor !== 'Unknown' && actor !== 'null'
    ? `, actor ${actor}`
    : actor === 'Unknown'
      ? ', actor not yet attributed'
      : ''

const physicsClause = (pc: string | undefined): string => {
  if (!pc || pc === 'None') return ''
  const n = Number(pc)
  return Number.isFinite(n) ? `; physics consistency ${n.toFixed(2)}` : ''
}

const authorityWords = (authority: string): string =>
  authority === 'local'
    ? 'handled at local authority'
    : authority === 'request'
      ? 'sent up as a request to higher authority'
      : `routed to ${authority} authority`

const subjectWords = (raw: string): string =>
  raw.startsWith('ctb://') ? spacecraftDisplayName(raw) : raw

const domainWords = (raw: string): string => domainLabel(raw as Domain)

const revisionWords = (revision: number, provisional: unknown): string =>
  revision === 0 || provisional === true ? 'provisional (revision 0)' : `revision ${revision}, final`

const UI_EVENT_WORDS: Record<string, string> = {
  recommendation_created: 'a recommendation for the operator',
  threat_updated: 'a threat update',
  recommendation_updated: 'an updated recommendation for the operator',
  threat_created: 'a new threat',
}

const uiEventWords = (type: string): string =>
  UI_EVENT_WORDS[type] ?? `a ${type.replaceAll('_', ' ')} event`

/** One sentence saying what the trace line means. Falls back to the raw
 *  message, first letter capitalised, for a shape this file does not know. */
export function traceHeadline(trace: ReasoningTrace): string {
  const message = trace.message.trim()
  const payload = trace.payload ?? {}
  let m: RegExpMatchArray | null

  if (trace.stage === 'fusion') {
    if ((m = message.match(/^new anomaly: (\S+) @ severity ([\d.]+)/))) {
      const severity = pct(m[2])
      return `New anomaly from fusion: ${anomalyKindLabel(m[1])}${severity ? `, severity ${severity}` : ''}.`
    }
    if ((m = message.match(/^cross-domain correlate: (\S+) with (.+?) on (\S+)$/))) {
      const others = m[2].split(',').map((kind) => anomalyKindLabel(kind.trim()))
      return `Two domains line up on ${subjectWords(m[3])}: ${anomalyKindLabel(m[1])} with ${[...new Set(others)].join(' and ')}.`
    }
    if ((m = message.match(/^cross-domain correlate: (\S+) with (.+?) \(global\)$/))) {
      const others = m[2].split(',').map((kind) => anomalyKindLabel(kind.trim()))
      return `Two domains line up across the fleet: ${anomalyKindLabel(m[1])} with ${[...new Set(others)].join(' and ')}, not tied to one spacecraft.`
    }
  }

  if (trace.stage === 'stress') {
    if ((m = message.match(/^input dropped: (\S+) blocked/))) {
      return `Input denied by stress mode: the ${domainWords(m[1])} report was dropped before fusion saw it.`
    }
    if ((m = message.match(/^\[(.+?)\] blocked — lowering confidence ([\d.]+) → ([\d.]+)/))) {
      const domains = m[1].split(',').map((d) => domainWords(d.replaceAll(/['"\s]/g, '')))
      return `Stress mode: ${domains.join(', ')} denied, so confidence was lowered from ${pct(m[2])} to ${pct(m[3])}.`
    }
  }

  if (trace.stage === 'attrib_primary') {
    if ((m = message.match(/^provisional verdict=(\S+) confidence=([\d.]+) basis=(\S+) pc=(\S+)/))) {
      return `Provisional verdict from the rule lane, before any model call: ${verdictWords(m[1])} at ${pct(m[2])} confidence${physicsClause(m[4])}.`
    }
    if ((m = message.match(/^actor=(\S+) confidence=([\d.]+) verdict=(\S+) basis=(\S+) pc=(\S+)/))) {
      return `Primary attribution by the model: ${verdictWords(m[3])}${actorClause(m[1])}, ${pct(m[2])} confidence${physicsClause(m[5])}.`
    }
  }

  if (trace.stage === 'attrib_redteam') {
    if ((m = message.match(/^challenge: (.+)$/s))) {
      const delta = typeof payload.confidence_delta === 'number' ? payload.confidence_delta : null
      const adjust =
        delta === null || delta === 0
          ? ''
          : ` Confidence adjusted by ${delta > 0 ? '+' : ''}${delta.toFixed(2)}.`
      return `Red-team challenge to the primary attribution: ${m[1].trim()}${adjust}`
    }
  }

  if (trace.stage === 'attrib_reconcile') {
    if ((m = message.match(/^final actor=(\S+) confidence=([\d.]+) verdict=(\S+) basis=(\S+) pc=(\S+)/))) {
      const revision = typeof payload.revision === 'number' ? ` (revision ${payload.revision})` : ''
      return `Final verdict after weighing the challenge: ${verdictWords(m[3])}${actorClause(m[1])}, ${pct(m[2])} confidence${physicsClause(m[5])}${revision}.`
    }
  }

  if (trace.stage.startsWith('attrib') && (m = message.match(/^reasoning lane failed; the provisional verdict stands: (.+)$/s))) {
    return `The reasoning lane failed, so the provisional verdict stands. Error: ${m[1].trim()}`
  }

  if (trace.stage === 'decide') {
    if ((m = message.match(/^provisional decision by rule: (\S+)/))) {
      return `Provisional decision by rule, before any model call: ${actionLabel(m[1])} holds until the final verdict.`
    }
    if ((m = message.match(/^operator (accepted|denied|reconsidered): (\S+)(?: → (.+))?$/))) {
      const what = actionLabel(m[2]).toLowerCase()
      if (m[1] === 'accepted') {
        return `Operator accepted the ${what}${m[3] ? `; it goes to ${targetLabel(m[3].trim())}` : ''}.`
      }
      if (m[1] === 'denied') return `Operator denied the ${what}; it is held for review.`
      return `Operator reconsidered the ${what}; it is pending again.`
    }
    if ((m = message.match(/^recovery withheld: (\S+): (\S+)/))) {
      return `Recovery withheld: ${recoveryActionLabel(m[1])} is held back. Reason: ${gateReasonLabel(m[2]).toLowerCase()}.`
    }
    if ((m = message.match(/^gate blocked (\S+): (\S+)/))) {
      return `Gate blocked the ${actionLabel(m[1]).toLowerCase()}. Reason: ${gateReasonLabel(m[2]).toLowerCase()}.`
    }
    if ((m = message.match(/^action=(\S+) authority=(\S+) target=(.+)$/s))) {
      return `Decision: ${actionLabel(m[1])}, ${authorityWords(m[2])}. Target: ${subjectWords(m[3].trim())}.`
    }
    if ((m = message.match(/^ui event (published|updated): (\S+) severity=(\S+) revision=(\d+)/))) {
      const what = uiEventWords(m[2])
      const verb = m[1] === 'published' ? 'Console notified of' : 'Console card updated with'
      return `${verb} ${what}: ${m[3]} severity, ${revisionWords(Number(m[4]), payload.provisional)}.`
    }
  }

  if (trace.stage === 'tools') {
    if ((m = message.match(/^routing\.validate → valid=(True|False) \(action (\S+) routed (\w+) to (\S+)\)/))) {
      const ok = m[1] === 'True'
      return `Routing check ${ok ? 'passed' : 'failed'}: ${actionLabel(m[2])} ${ok ? 'goes to' : 'should not go to'} ${m[4]} authority.`
    }
    if ((m = message.match(/^(\S+) failed: (.+)$/s))) {
      return `Tool ${m[1]} failed: ${m[2].trim()}`
    }
  }

  return message ? message.charAt(0).toUpperCase() + message.slice(1) : ''
}
