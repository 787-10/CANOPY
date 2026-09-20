import type { Attribution, Decision } from '../../types/canopy'
import { DecisionSummaryCard, VerdictSummaryCard } from '../SummaryCards'

type ResponseColumnProps = {
  attribution: Attribution | null
  decision: Decision | null
}

/** The right column: the verdict card, then the decision card with Accept
 *  and Deny. One place for each thing; the full operator panel with the
 *  authority, target and rationale is on the Verdict page. The cards say so
 *  until the engine has produced a verdict or a decision. */
export function ResponseColumn({ attribution, decision }: ResponseColumnProps) {
  return (
    <div className="response" data-testid="response-column">
      <VerdictSummaryCard attribution={attribution} />
      <DecisionSummaryCard decision={decision} />
    </div>
  )
}
