import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { VerdictPanel } from './VerdictPanel'
import { useEventStore } from '../store/eventStore'
import { makeAttribution, makeDecision, makeKBEntry } from '../test/factories'
import type { Verdict } from '../types/canopy'

beforeEach(() => {
  useEventStore.getState().reset()
})

// Snapshot-style: the analyst-visible facts of one render, flattened so the
// expectation for each verdict reads as a table rather than a DOM dump.
const snapshotOf = (container: HTMLElement) => {
  const section = container.querySelector('section.verdict-panel')
  const query = (testId: string) =>
    section?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  const list = (testId: string) =>
    Array.from(
      section?.querySelectorAll(`[data-testid="${testId}"] li`) ?? [],
    ).map((li) => li.textContent)
  return {
    verdict: section?.getAttribute('data-verdict') ?? null,
    badge: query('verdict-badge'),
    badgeClass: Array.from(
      section?.querySelector('[data-testid="verdict-badge"]')?.classList ?? [],
    ).find((c) => c.startsWith('verdict-panel__badge--')),
    physics: query('physics-consistency'),
    meterNow:
      section?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow') ??
      null,
    basis: query('verdict-basis'),
    satellite: query('verdict-satellite'),
    verdictEvidence: list('verdict-evidence'),
    evidence: list('evidence'),
    headline: section?.querySelector('.verdict-panel__headline')?.textContent ?? null,
  }
}

const SAT = 'ctb://centralblue.dev/leo-science-1'

describe('VerdictPanel — one distinct state per verdict', () => {
  it('internal fault', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-if', {
          actor: 'None',
          confidence: 0.83,
          verdict: 'internal_fault',
          physics_consistency: 0.83,
          verdict_basis: 'rule',
          verdict_evidence: [],
          evidence: ['Amplifier output ramp matches degradation model'],
          satellite_id: SAT,
        })}
      />,
    )
    expect(snapshotOf(container)).toEqual({
      verdict: 'internal_fault',
      badge: 'Internal fault',
      badgeClass: 'verdict-panel__badge--internal_fault',
      physics: '0.83',
      meterNow: '0.83',
      basis: 'Rule lane',
      satellite: SAT,
      verdictEvidence: [],
      evidence: ['Amplifier output ramp matches degradation model'],
      headline: 'Internal fault on LEO-SCIENCE-1',
    })
    // The rule lane kept the verdict, so the panel says so instead of
    // rendering an empty list.
    expect(
      screen.getByText('No reasoning-lane citations; the rule verdict stands.'),
    ).toBeInTheDocument()
  })

  it('natural external', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-ne', {
          actor: 'None',
          confidence: 0.66,
          verdict: 'natural_external',
          physics_consistency: 0.41,
          verdict_basis: 'rule',
          verdict_evidence: [],
          evidence: ['G2 storm window overlaps the decay onset'],
          satellite_id: SAT,
        })}
      />,
    )
    expect(snapshotOf(container)).toEqual({
      verdict: 'natural_external',
      badge: 'Natural external',
      badgeClass: 'verdict-panel__badge--natural_external',
      physics: '0.41',
      meterNow: '0.41',
      basis: 'Rule lane',
      satellite: SAT,
      verdictEvidence: [],
      evidence: ['G2 storm window overlaps the decay onset'],
      headline: 'Natural external on LEO-SCIENCE-1',
    })
  })

  it('hostile external, changed by the reasoning lane with cited evidence', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-he', {
          actor: 'Ghost Lance cell',
          confidence: 0.78,
          verdict: 'hostile_external',
          physics_consistency: 0.22,
          verdict_basis: 'reasoning',
          verdict_evidence: ['rf_anomaly on the same uplink 90 s before onset'],
          evidence: ['Link margin step, not ramp'],
          satellite_id: SAT,
        })}
      />,
    )
    expect(snapshotOf(container)).toEqual({
      verdict: 'hostile_external',
      badge: 'Hostile external',
      badgeClass: 'verdict-panel__badge--hostile_external',
      physics: '0.22',
      meterNow: '0.22',
      basis: 'Reasoning lane',
      satellite: SAT,
      verdictEvidence: ['rf_anomaly on the same uplink 90 s before onset'],
      evidence: ['Link margin step, not ramp'],
      headline: 'Hostile external: pattern consistent with Ghost Lance cell',
    })
  })

  it('unknown, with no physics score and no satellite', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-un', {
          actor: 'Unknown',
          confidence: 0.49,
          verdict: 'unknown',
          physics_consistency: null,
          verdict_basis: 'rule',
          verdict_evidence: ['high consistency but hostile context in window'],
          evidence: [],
        })}
      />,
    )
    expect(snapshotOf(container)).toEqual({
      verdict: 'unknown',
      badge: 'Unknown',
      badgeClass: 'verdict-panel__badge--unknown',
      physics: 'not scored',
      meterNow: null,
      basis: 'Rule lane',
      satellite: 'not identified',
      verdictEvidence: ['high consistency but hostile context in window'],
      evidence: [],
      headline: 'Unknown on the affected spacecraft',
    })
    expect(screen.getByText('No evidence strings attached.')).toBeInTheDocument()
  })

  it('the four verdict badges never share a class or a label', () => {
    const verdicts: Verdict[] = [
      'internal_fault',
      'natural_external',
      'hostile_external',
      'unknown',
    ]
    const seen = new Set<string>()
    for (const verdict of verdicts) {
      const { container, unmount } = render(
        <VerdictPanel attribution={makeAttribution(`att-${verdict}`, { verdict })} />,
      )
      const snap = snapshotOf(container)
      seen.add(`${snap.badgeClass}|${snap.badge}`)
      unmount()
    }
    expect(seen.size).toBe(4)
  })
})

describe('VerdictPanel — absent verdict and empty states', () => {
  it('renders a legacy attribution with none of the new fields as "No verdict yet"', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-legacy', {
          actor: 'Ghost Lance cell',
          confidence: 0.84,
          evidence: ['RF burst timing matches known pre-jam rehearsal pattern'],
          kb_citations: ['KB-17-044'],
        })}
      />,
    )
    expect(snapshotOf(container)).toEqual({
      verdict: 'absent',
      badge: 'No verdict yet',
      badgeClass: 'verdict-panel__badge--absent',
      physics: 'not scored',
      meterNow: null,
      basis: 'no lane recorded',
      satellite: 'not identified',
      verdictEvidence: [],
      evidence: ['RF burst timing matches known pre-jam rehearsal pattern'],
      headline: 'Ghost Lance cell pattern under review',
    })
    // No verdict-evidence section at all for a legacy attribution; the
    // existing evidence and citations still render.
    expect(screen.queryByLabelText('Verdict evidence')).not.toBeInTheDocument()
    expect(screen.getByLabelText('KB citations')).toHaveTextContent('KB-17-044')
    expect(screen.getByLabelText('KB citations')).toHaveTextContent('unresolved')
  })

  it('treats an explicit null verdict the same as a missing one', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-null', {
          verdict: null,
          physics_consistency: null,
          verdict_basis: null,
          verdict_evidence: [],
          satellite_id: null,
        })}
      />,
    )
    expect(snapshotOf(container).badge).toBe('No verdict yet')
    expect(snapshotOf(container).verdict).toBe('absent')
  })

  it('stands by when there is no attribution at all', () => {
    const { container } = render(<VerdictPanel attribution={null} />)
    expect(snapshotOf(container).badge).toBe('No verdict yet')
    expect(screen.getByText('standing by')).toBeInTheDocument()
    expect(screen.queryByTestId('physics-consistency')).not.toBeInTheDocument()
  })

  it('resolves KB citations through the store', () => {
    useEventStore
      .getState()
      .setKB([makeKBEntry('KB-21-119', { title: 'Counter-C2 isolation' })])
    render(
      <VerdictPanel
        attribution={makeAttribution('att-kb', { kb_citations: ['KB-21-119'] })}
      />,
    )
    expect(screen.getByText('Counter-C2 isolation')).toBeInTheDocument()
  })
})

describe('VerdictPanel — decision section', () => {
  it('shows the recovery block of a recovery_recommendation', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-r', { verdict: 'internal_fault' })}
        decision={makeDecision('dec-r', {
          attribution_id: 'att-r',
          action: 'recovery_recommendation',
          authority: 'local',
          rationale: 'Primary amplifier is degrading; the redundant unit is nominal.',
          recovery: {
            action_id: 'switch_redundant_amplifier',
            target_subsystem: 'comms',
            requires_approval: true,
            rationale: 'Primary amplifier output trending down; redundant unit nominal.',
            source: 'internal-diagnosis',
            satellite_id: SAT,
          },
        })}
      />,
    )
    const recovery = within(screen.getByTestId('recovery'))
    expect(recovery.getByText('Switch redundant amplifier')).toBeInTheDocument()
    expect(recovery.getByText('switch_redundant_amplifier')).toBeInTheDocument()
    expect(recovery.getByText('Comms')).toBeInTheDocument()
    expect(recovery.getByText('Operator approval required')).toBeInTheDocument()
    expect(recovery.getByText('internal diagnosis')).toBeInTheDocument()
    expect(
      recovery.getByText(
        'Primary amplifier output trending down; redundant unit nominal.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('gate-chip')).not.toBeInTheDocument()
  })

  it('shows a gate-blocked decision with the reason as a chip and the prefix stripped', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-b', { verdict: 'internal_fault' })}
        decision={makeDecision('dec-b', {
          attribution_id: 'att-b',
          action: 'threat_warning',
          authority: 'local',
          rationale:
            '[gate:threat/uplink_jamming_active] Recovery on comms withheld while jamming is active.',
          recovery: null,
        })}
      />,
    )
    const chip = screen.getByTestId('gate-chip')
    expect(chip).toHaveTextContent('Blocked: Active jamming detected')
    expect(chip).toHaveAttribute('title', 'threat/uplink_jamming_active')
    expect(
      screen.getByText('Recovery on comms withheld while jamming is active.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/\[gate:/)).not.toBeInTheDocument()
  })

  it('renders the request packet of a request-authority decision', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-p')}
        decision={makeDecision('dec-p', {
          attribution_id: 'att-p',
          request_packet: { packet_id: 'REQ-009', ttl_minutes: 6 },
        })}
      />,
    )
    expect(screen.getByText('REQ-009')).toBeInTheDocument()
    expect(screen.getByText(/"ttl_minutes": 6/)).toBeInTheDocument()
  })
})
