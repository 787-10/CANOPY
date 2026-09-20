import type { ReactNode } from 'react'

type DisclosureProps = {
  id: string
  label: string
  /** Count chip next to the label (rows, points, denied domains). */
  count: number | string
  open: boolean
  onToggle: () => void
  children: ReactNode
}

/** One section of the Situation accordion: a button header with the label
 *  in Chakra Petch and a count chip, `aria-expanded`, and a body the header
 *  controls. Styled like a `<details>` element without its keyboard quirks. */
export function Disclosure({ id, label, count, open, onToggle, children }: DisclosureProps) {
  const bodyId = `${id}-body`
  return (
    <section className={`disclosure${open ? ' disclosure--open' : ''}`} data-testid={id}>
      <h3 className="disclosure__head">
        <button
          type="button"
          className="disclosure__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="disclosure__chevron" aria-hidden="true" />
          <span className="disclosure__label">{label}</span>
          <span className="disclosure__count">{count}</span>
        </button>
      </h3>
      <div id={bodyId} className="disclosure__body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
