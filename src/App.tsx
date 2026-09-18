import { Brigade } from './pages/Brigade'
import { DemoLauncher } from './pages/DemoLauncher'
import { Operator } from './pages/Operator'
import { RunSummary } from './pages/RunSummary'
import { SignalZoom } from './pages/SignalZoom'
import { Spacecraft } from './pages/Spacecraft'
import { resolveRoute } from './lib/routes'
import { initialiseCaptureMode } from './store/captureStore'
import './App.css'

// Capture mode is read from `?capture=1` / sessionStorage before the first
// render so the map opens on the globe and the trace pane starts collapsed.
initialiseCaptureMode()

function App() {
  const route = resolveRoute(window.location.pathname, window.location.search)

  switch (route.page) {
    case 'operator':
      return <Operator />
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

export default App
