import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VerdictPanel } from './VerdictPanel'
import { useEventStore } from '../store/eventStore'
import { makeAttribution, makeKBEntry } from '../test/factories'
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

  it('names the candidate objects of an unresolved attribution (spec §5.4)', () => {
    const { container } = render(
      <VerdictPanel
        attribution={makeAttribution('att-cs', {
          actor: 'Unknown',
          confidence: 0.45,
          verdict: 'unknown',
          physics_consistency: null,
          verdict_basis: 'rule',
          verdict_evidence: [],
          evidence: ['Verdict (rule): unknown. rule 6: unknown confidence=0.30 (candidate cue unresolved among [...])'],
          satellite_id: null,
          candidate_satellite_ids: [SAT, 'ctb://centralblue.dev/leo-science-2'],
        })}
      />,
    )
    const chips = screen.getByTestId('verdict-candidates')
    expect(chips).toHaveTextContent('LEO-SCIENCE-1 or LEO-SCIENCE-2, unresolved')
    expect(
      Array.from(chips.querySelectorAll('.verdict-panel__candidate')).map((c) => c.textContent),
    ).toEqual(['LEO-SCIENCE-1', 'LEO-SCIENCE-2'])
    // Hidden from captures so the layout does not shift; the subject slot says why.
    expect(chips).toHaveAttribute('data-capture-hide')
    expect(container.querySelector('.verdict-panel__subject')).toHaveTextContent('unresolved')
    expect(snapshotOf(container).badge).toBe('Unknown')
    expect(snapshotOf(container).headline).toBe('Unknown on the affected spacecraft')
  })

  it('shows no candidate row for a keyed attribution, whatever it lists', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-keyed', {
          verdict: 'hostile_external',
          satellite_id: SAT,
          candidate_satellite_ids: [SAT, 'ctb://centralblue.dev/leo-science-2'],
        })}
      />,
    )
    expect(screen.queryByTestId('verdict-candidates')).not.toBeInTheDocument()
    expect(screen.getByText('LEO-SCIENCE-1')).toBeInTheDocument()
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

describe('VerdictPanel — basis wording on a final revision (V11)', () => {
  it('says the reasoning lane confirmed a rule verdict once the final revision keeps it', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-confirmed', {
          verdict: 'internal_fault',
          verdict_basis: 'rule',
          revision: 1,
          provisional: false,
          satellite_id: SAT,
        })}
      />,
    )
    const basis = screen.getByTestId('verdict-basis')
    expect(basis).toHaveTextContent('Rule lane, confirmed by the reasoning lane')
    expect(basis).toHaveAttribute(
      'title',
      'The reasoning lane reviewed the evidence and kept the rule verdict.',
    )
  })

  it('keeps the plain rule-lane label on the provisional revision', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-prov', {
          verdict: 'internal_fault',
          verdict_basis: 'rule',
          revision: 0,
          provisional: true,
        })}
      />,
    )
    expect(screen.getByTestId('verdict-basis')).toHaveTextContent(/^Rule lane$/)
  })
})

describe('VerdictPanel — folds for the fixed-height Verdict page', () => {
  const lines = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`)

  it('keeps the first evidenceLimit lines in view and folds the rest behind "+k more"', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-fold', {
          verdict: 'internal_fault',
          verdict_basis: 'rule',
          satellite_id: SAT,
          evidence: [...lines(5, 'evidence'), 'Verdict (rule): internal_fault. rule 1'],
        })}
        evidenceLimit={3}
      />,
    )
    const shown = Array.from(screen.getByTestId('evidence').querySelectorAll('li')).map((li) => li.textContent)
    expect(shown).toEqual(['evidence line 1', 'evidence line 2', 'evidence line 3'])
    const more = screen.getByTestId('evidence-more')
    expect(more.tagName).toBe('DETAILS')
    expect(more.querySelector('summary')).toHaveTextContent('+2 more')
    expect(
      Array.from(screen.getByTestId('evidence-rest').querySelectorAll('li')).map((li) => li.textContent),
    ).toEqual(['evidence line 4', 'evidence line 5'])
    // The rule basis keeps its own fold beside it; every line is still on the page.
    expect(screen.getByTestId('rule-basis')).toHaveTextContent('Verdict (rule): internal_fault. rule 1')
    expect(screen.getByTestId('rule-basis').parentElement).toBe(more.parentElement)
  })

  it('folds the "Cited for the verdict" lines beyond citedLimit the same way', () => {
    render(
      <VerdictPanel
        attribution={makeAttribution('att-cited', {
          verdict: 'hostile_external',
          verdict_basis: 'reasoning',
          satellite_id: SAT,
          verdict_evidence: lines(4, 'cited'),
        })}
        citedLimit={2}
      />,
    )
    expect(
      Array.from(screen.getByTestId('verdict-evidence').querySelectorAll('li')).map((li) => li.textContent),
    ).toEqual(['cited line 1', 'cited line 2'])
    expect(screen.getByTestId('verdict-evidence-more').querySelector('summary')).toHaveTextContent('+2 more')
    expect(screen.getByTestId('verdict-evidence-rest')).toHaveTextContent('cited line 4')
  })

  it('shows every line and no fold when the list fits the limit, and by default', () => {
    const { rerender } = render(
      <VerdictPanel
        attribution={makeAttribution('att-fits', {
          verdict: 'internal_fault',
          verdict_basis: 'rule',
          satellite_id: SAT,
          evidence: lines(3, 'evidence'),
          verdict_evidence: lines(2, 'cited'),
        })}
        evidenceLimit={3}
        citedLimit={2}
      />,
    )
    expect(screen.queryByTestId('evidence-more')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verdict-evidence-more')).not.toBeInTheDocument()
    rerender(
      <VerdictPanel
        attribution={makeAttribution('att-fits', {
          verdict: 'internal_fault',
          verdict_basis: 'rule',
          satellite_id: SAT,
          evidence: lines(12, 'evidence'),
        })}
      />,
    )
    expect(screen.getByTestId('evidence').querySelectorAll('li')).toHaveLength(12)
    expect(screen.queryByTestId('evidence-more')).not.toBeInTheDocument()
  })

  it('renders each KB citation as one line (id and title on the toggle) with the entry text folded, and counts them in the heading', () => {
    useEventStore.getState().setKB([
      makeKBEntry('KB-A', { title: 'Amplifier ageing physics', summary: 'Forward power falls as the device heats.', decision_implications: ['Switch to the redundant chain.'] }),
      makeKBEntry('KB-B', { title: 'Uncertainty anchor', summary: 'Public indicators are not proof.' }),
    ])
    render(
      <VerdictPanel attribution={makeAttribution('att-kb2', { kb_citations: ['KB-A', 'KB-B', 'KB-MISSING'] })} />,
    )
    expect(screen.getByTestId('kb-citation-count')).toHaveTextContent('3')
    const cards = screen.getAllByTestId('kb-card')
    expect(cards).toHaveLength(3)
    const [a, , missing] = cards
    expect(a.tagName).toBe('DETAILS')
    expect(a).not.toHaveAttribute('open')
    expect(a.querySelector('summary')).toHaveTextContent('KB-A')
    expect(a.querySelector('summary')).toHaveTextContent('Amplifier ageing physics')
    expect(a.querySelector('summary')).toHaveAttribute('title', 'Amplifier ageing physics')
    // The record is inside the fold, not on the toggle line.
    expect(a.querySelector('summary')).not.toHaveTextContent('Forward power falls')
    expect(a.querySelector('.kb-card__body')).toHaveTextContent('Forward power falls as the device heats.')
    expect(a.querySelector('.kb-card__body')).toHaveTextContent('Switch to the redundant chain.')
    expect(a.querySelector('.kb-card__body')).toHaveTextContent('RED · co-orbital')
    // An unresolved id is a plain line, nothing to open.
    expect(missing.tagName).toBe('DIV')
    expect(missing).toHaveTextContent('KB-MISSING')
    expect(missing).toHaveTextContent('unresolved')
  })
})
