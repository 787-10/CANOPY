// Path + query -> console route. The console has no router library; App
// switches on this.
export type Route =
  | { page: 'brigade' }
  | { page: 'operator' }
  | { page: 'spacecraft'; sat: string | null }
  | { page: 'signal'; id: string | null }
  | { page: 'demo'; run: string | null; autostart: boolean }
  | { page: 'run' }

/** Unknown paths fall back to the Brigade view. */
export function resolveRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search)
  if (pathname.startsWith('/operator')) return { page: 'operator' }
  if (pathname.startsWith('/spacecraft')) {
    return { page: 'spacecraft', sat: params.get('sat') }
  }
  if (pathname.startsWith('/signal')) return { page: 'signal', id: params.get('id') }
  if (pathname.startsWith('/demo')) {
    return {
      page: 'demo',
      run: params.get('run'),
      autostart: params.get('autostart') === '1',
    }
  }
  if (pathname.startsWith('/runs')) return { page: 'run' }
  return { page: 'brigade' }
}
