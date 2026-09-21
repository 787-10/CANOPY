// Path + query -> console route. The console has no router library; App
// switches on this.
export type Route =
  | { page: 'brigade' }
  | { page: 'verdict' }
  | { page: 'reasoning' }
  | { page: 'signals' }
  | { page: 'spacecraft'; sat: string | null }
  | { page: 'signal'; id: string | null }
  | { page: 'demo'; run: string | null; autostart: boolean; flight: string | null }
  | { page: 'run' }

/** Unknown paths (the retired /operator among them) fall back to the console. */
export function resolveRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search)
  if (pathname.startsWith('/verdict')) return { page: 'verdict' }
  if (pathname.startsWith('/reasoning')) return { page: 'reasoning' }
  if (pathname.startsWith('/signals')) return { page: 'signals' }
  if (pathname.startsWith('/spacecraft')) {
    return { page: 'spacecraft', sat: params.get('sat') }
  }
  if (pathname.startsWith('/signal')) return { page: 'signal', id: params.get('id') }
  if (pathname.startsWith('/demo')) {
    return {
      page: 'demo',
      run: params.get('run'),
      autostart: params.get('autostart') === '1',
      flight: params.get('flight'),
    }
  }
  if (pathname.startsWith('/runs')) return { page: 'run' }
  return { page: 'brigade' }
}
