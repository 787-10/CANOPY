import { describe, expect, it } from 'vitest'
import { TRACE_CATEGORY, traceHeadline } from './traceCopy'
import { makeTrace } from '../test/factories'
import type { TraceStage } from '../types/canopy'

const line = (stage: TraceStage, message: string, payload: Record<string, unknown> = {}) =>
  makeTrace('t', { stage, message, payload })

describe('traceHeadline', () => {
  it('names every stage in words and keeps the engine code', () => {
    expect(TRACE_CATEGORY.attrib_redteam).toEqual({ label: 'Attribution · red team', code: 'attrib.redteam' })
    expect(TRACE_CATEGORY.decide.label).toBe('Decide')
  })

  it('turns the decide-stage log lines into sentences', () => {
    expect(traceHeadline(line('decide', 'ui event updated: recommendation_created severity=medium revision=1'))).toBe(
      'Console card updated with a recommendation for the operator: medium severity, revision 1, final.',
    )
    expect(traceHeadline(line('decide', 'ui event published: threat_updated severity=high revision=0'))).toBe(
      'Console notified of a threat update: high severity, provisional (revision 0).',
    )
    expect(traceHeadline(line('decide', 'action=threat_warning authority=local target=brigade-c2'))).toBe(
      'Decision: Threat warning, handled at local authority. Target: brigade-c2.',
    )
    expect(traceHeadline(line('decide', 'recovery withheld: reset_transponder_chain: threat/uplink_jamming_active'))).toBe(
      'Recovery withheld: Reset transponder chain is held back. Reason: active jamming detected.',
    )
    expect(traceHeadline(line('decide', 'gate blocked recovery_recommendation: verdict/hostile_external'))).toBe(
      'Gate blocked the recovery recommendation. Reason: verdict: hostile external.',
    )
  })

  it('reads the rule-made provisional decision', () => {
    expect(traceHeadline(line('decide', 'provisional decision by rule: threat_warning (fast lane, no LLM)'))).toBe(
      'Provisional decision by rule, before any model call: Threat warning holds until the final verdict.',
    )
  })

  it('reads the operator lines the gateway writes for Accept, Deny and Reconsider', () => {
    expect(traceHeadline(line('decide', 'operator accepted: threat_warning → brigade-c2'))).toBe(
      'Operator accepted the threat warning; it goes to Brigade C2.',
    )
    expect(traceHeadline(line('decide', 'operator accepted: recovery_recommendation → comms'))).toBe(
      'Operator accepted the recovery recommendation; it goes to Comms.',
    )
    expect(traceHeadline(line('decide', 'operator denied: threat_warning → brigade-c2'))).toBe(
      'Operator denied the threat warning; it is held for review.',
    )
    expect(traceHeadline(line('decide', 'operator reconsidered: threat_warning'))).toBe(
      'Operator reconsidered the threat warning; it is pending again.',
    )
  })

  it('explains fusion, attribution and tool lines', () => {
    expect(traceHeadline(line('fusion', 'new anomaly: bus_link_margin @ severity 0.85'))).toBe(
      'New anomaly from fusion: Link margin drop, severity 85%.',
    )
    expect(traceHeadline(line('fusion', 'cross-domain correlate: bus_link_margin with rf_anomaly, rf_anomaly on ctb://megalith.demo/sim-01'))).toBe(
      'Two domains line up on SIM-01: Link margin drop with RF interference.',
    )
    expect(traceHeadline(line('attrib_primary', 'provisional verdict=hostile_external confidence=0.49 basis=rule pc=0.17 (fast lane, no LLM)'))).toBe(
      'Provisional verdict from the rule lane, before any model call: Hostile external at 49% confidence; physics consistency 0.17.',
    )
    expect(traceHeadline(line('attrib_primary', 'actor=Actor-1 confidence=0.85 verdict=hostile_external basis=rule pc=0.17'))).toBe(
      'Primary attribution by the model: Hostile external, actor Actor-1, 85% confidence; physics consistency 0.17.',
    )
    expect(traceHeadline(line('attrib_redteam', 'challenge: The evidence is strong.', { confidence_delta: -0.05 }))).toBe(
      'Red-team challenge to the primary attribution: The evidence is strong. Confidence adjusted by -0.05.',
    )
    expect(traceHeadline(line('attrib_reconcile', 'final actor=None confidence=0.80 verdict=internal_fault basis=rule pc=0.94', { revision: 1 }))).toBe(
      'Final verdict after weighing the challenge: Internal fault, 80% confidence; physics consistency 0.94 (revision 1).',
    )
    expect(traceHeadline(line('tools', 'routing.validate → valid=True (action threat_warning routed correctly to local)'))).toBe(
      'Routing check passed: Threat warning goes to local authority.',
    )
    expect(traceHeadline(line('stress', 'input dropped: rf_ew blocked'))).toBe(
      'Input denied by stress mode: the EW interference report was dropped before fusion saw it.',
    )
  })

  it('falls back to the raw message, capitalised, for an unknown shape', () => {
    expect(traceHeadline(line('fusion', 'something new happened'))).toBe('Something new happened')
  })
})
