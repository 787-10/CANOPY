import { Hotkeys } from './components/Hotkeys'
import { Brigade } from './pages/Brigade'
import { DemoLauncher } from './pages/DemoLauncher'
import { ReasoningPage } from './pages/ReasoningPage'
import { RunSummary } from './pages/RunSummary'
import { SignalsPage } from './pages/SignalsPage'
import { SignalZoom } from './pages/SignalZoom'
import { Spacecraft } from './pages/Spacecraft'
import { VerdictPage } from './pages/VerdictPage'
import { useEffect } from 'react'
import { useLocation } from './lib/navigation'
import { resolveRoute } from './lib/routes'
import { initialiseCaptureMode } from './store/captureStore'
import { initialiseFlightView } from './store/clockStore'
import './App.css'
import './styles/scrollbars.css'
import './styles/spacecraft.css'
import './styles/flight.css'

// Capture mode (fixed 1920x1080 layout) is read from `?capture=1` /
// sessionStorage before the first render.
initialiseCaptureMode()
// The flight view (docs/MEGALITH-Flight-Plan.md) follows: `?flight=1` or the
// session flag, never in capture mode.
initialiseFlightView()

function pageFor(route: ReturnType<typeof resolveRoute>) {
  switch (route.page) {
    case 'verdict':
      return <VerdictPage />
    case 'reasoning':
      return <ReasoningPage />
    case 'signals':
      return <SignalsPage />
    case 'spacecraft':
      return <Spacecraft requestedSatellite={route.sat} />
    case 'signal':
      return <SignalZoom signalId={route.id} />
    case 'demo':
      return <DemoLauncher run={route.run} autostart={route.autostart} flight={route.flight} />
    case 'run':
      return <RunSummary />
    default:
      return <Brigade />
  }
}

function App() {
  // Pages change in this document (lib/navigation.ts): a fullscreen console
  // keeps its fullscreen across the header links and the page keys. The
  // capture and flight flags in the new URL are applied as on a load.
  const location = useLocation()
  useEffect(() => {
    initialiseCaptureMode(location.search)
    initialiseFlightView(location.search)
  }, [location.pathname, location.search])
  const route = resolveRoute(location.pathname, location.search)
  return (
    <>
      <Hotkeys />
      {pageFor(route)}
    </>
  )
}

export default App
