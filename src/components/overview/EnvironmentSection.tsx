import { useStressDomains } from '../../hooks/useStressDomains'
import { domainLabel } from '../../lib/commanderLanguage'
import { environmentFacts } from '../../lib/situation'
import { withCapture } from '../../store/captureStore'
import { useEventStore } from '../../store/eventStore'
import { Disclosure } from './Disclosure'

type EnvironmentSectionProps = {
  open: boolean
  onToggle: () => void
}

/** The space environment and the inputs: the latest space-weather report
 *  (event and Kp) and the domains stress mode denies. */
export function EnvironmentSection({ open, onToggle }: EnvironmentSectionProps) {
  const signals = useEventStore((s) => s.signals)
  const denied = useStressDomains()
  const facts = environmentFacts(signals)
  return (
    <Disclosure id="environment" label="Environment" count={denied.length ? `${denied.length} denied` : 'clear'} open={open} onToggle={onToggle}>
      <dl className="facts" data-testid="environment-facts">
        <div>
          <dt>Space weather</dt>
          <dd data-testid="environment-weather">
            {facts.eventLabel}
            {facts.kp !== null ? ` · Kp ${facts.kp.toFixed(1)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Inputs denied</dt>
          <dd data-testid="environment-denied">
            {denied.length ? denied.map((domain) => domainLabel(domain)).join(', ') : 'none denied'}
          </dd>
        </div>
      </dl>
      <a className="side-column__link" href={withCapture('/signals')}>
        Signals and inputs →
      </a>
    </Disclosure>
  )
}
