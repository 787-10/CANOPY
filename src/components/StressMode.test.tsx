import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StressMode } from './StressMode'

const response = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('StressMode gateway calls', () => {
  it('reads and writes /stress on the open gateway with no credential added', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ blocked_domains: ['rf_ew'] }))
    render(<StressMode fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('stress-banner')).toHaveTextContent('RF / EW'))
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/stress')
    expect(fetchImpl.mock.calls[0]).toHaveLength(1)

    fetchImpl.mockResolvedValue(response({ blocked_domains: ['rf_ew', 'cyber'] }))
    fireEvent.click(screen.getByLabelText('Cyber'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByTestId('stress-banner')).toHaveTextContent('Cyber'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenLastCalledWith('http://localhost:8000/stress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked_domains: ['rf_ew', 'cyber'] }),
    })
  })

  it('sends the bearer header on the read and the write when the console carries a token (C11)', async () => {
    vi.stubEnv('VITE_CANOPY_API_TOKEN', 'deploy-secret')
    const fetchImpl = vi.fn().mockResolvedValue(response({ blocked_domains: [] }))
    render(<StressMode fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/stress', {
      headers: { Authorization: 'Bearer deploy-secret' },
    })

    fetchImpl.mockResolvedValue(response({ blocked_domains: ['pnt'] }))
    fireEvent.click(screen.getByLabelText('PNT / GNSS'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByTestId('stress-banner')).toHaveTextContent('PNT / GNSS'))
    expect(fetchImpl).toHaveBeenLastCalledWith('http://localhost:8000/stress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer deploy-secret' },
      body: JSON.stringify({ blocked_domains: ['pnt'] }),
    })
  })
})
