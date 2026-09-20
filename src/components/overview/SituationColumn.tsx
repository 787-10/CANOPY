import { useState } from 'react'
import { EnvironmentSection } from './EnvironmentSection'
import { SpacecraftSection } from './SpacecraftSection'
import { TheatersSection } from './TheatersSection'

type Section = 'theaters' | 'spacecraft' | 'environment'

type SituationColumnProps = {
  /** The episode's satellite, for the Spacecraft section. */
  satelliteId: string | null
}

/** The left column: three disclosures, Theaters open by default. Which are
 *  open is component state; it is not persisted. */
export function SituationColumn({ satelliteId }: SituationColumnProps) {
  const [open, setOpen] = useState<Record<Section, boolean>>({
    theaters: true,
    spacecraft: false,
    environment: false,
  })
  const toggle = (section: Section) => () =>
    setOpen((current) => ({ ...current, [section]: !current[section] }))
  return (
    <div className="situation" data-testid="situation-column">
      <TheatersSection open={open.theaters} onToggle={toggle('theaters')} />
      <SpacecraftSection satelliteId={satelliteId} open={open.spacecraft} onToggle={toggle('spacecraft')} />
      <EnvironmentSection open={open.environment} onToggle={toggle('environment')} />
    </div>
  )
}
