import { Hotkeys } from './components/Hotkeys'
import { Brigade } from './pages/Brigade'
import { DemoLauncher } from './pages/DemoLauncher'
import { ReasoningPage } from './pages/ReasoningPage'
import { RunSummary } from './pages/RunSummary'
import { SignalsPage } from './pages/SignalsPage'
import { SignalZoom } from './pages/SignalZoom'
import { Spacecraft } from './pages/Spacecraft'
import { VerdictPage } from './pages/VerdictPage'
import { resolveRoute } from './lib/routes'
import { initialiseCaptureMode } from './store/captureStore'
import './App.css'
import './styles/scrollbars.css'
import './styles/spacecraft.css'

// Capture mode (fixed 1920x1080 layout) is read from `?capture=1` /
// sessionStorage before the first render.
initialiseCaptureMode()

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
      return <DemoLauncher run={route.run} autostart={route.autostart} />
    case 'run':
      return <RunSummary />
    default:
      return <Brigade />
  }
}

function App() {
  const route = resolveRoute(window.location.pathname, window.location.search)
  return (
    <>
      <Hotkeys />
      {pageFor(route)}
    </>
  )
}

export default App
