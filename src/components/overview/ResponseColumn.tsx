import type { Attribution, Decision } from '../../types/canopy'
import { OperatorActionPanel } from '../OperatorActionPanel'
import { DecisionSummaryCard, VerdictSummaryCard } from '../SummaryCards'

type ResponseColumnProps = {
  attribution: Attribution | null
  decision: Decision | null
}

/** The right column: the approve/deny box on top (the operator action panel
 *  in its compact form), the verdict and decision summaries under it. The
 *  panel renders nothing until a decision exists; the cards say so. */
export function ResponseColumn({ attribution, decision }: ResponseColumnProps) {
  return (
    <div className="response" data-testid="response-column">
      <OperatorActionPanel decision={decision} compact />
      <VerdictSummaryCard attribution={attribution} />
      <DecisionSummaryCard decision={decision} actions={false} />
    </div>
  )
}
