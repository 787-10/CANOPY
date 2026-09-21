/** The console's pages: the nav order in the top bar and the 1 to 6 hotkeys. */
export type ConsolePage =
  | 'brigade'
  | 'verdict'
  | 'reasoning'
  | 'signals'
  | 'spacecraft'
  | 'run'
  | 'signal'
  | 'demo'

export const PAGES: Array<{ page: ConsolePage; label: string; href: string }> = [
  { page: 'brigade', label: 'Console', href: '/brigade' },
  { page: 'verdict', label: 'Verdict', href: '/verdict' },
  { page: 'reasoning', label: 'Reasoning', href: '/reasoning' },
  { page: 'signals', label: 'Signals', href: '/signals' },
  { page: 'spacecraft', label: 'Spacecraft', href: '/spacecraft' },
  { page: 'run', label: 'Run', href: '/runs' },
]
