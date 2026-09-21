// Greenwich mean sidereal time, the IAU 1982 polynomial on Unix seconds: a
// line-for-line port of `_gmst_rad` in megalith/scenarios/demo/tracks.py, so
// the console's propagator reproduces the generated track files exactly.
// Callers must pass Unix time (UTC), never a Cesium JulianDate day number,
// which is TAI and 37 s away: that error is 0.154° of longitude.

/** Python's `%`: the result takes the sign of the divisor. */
export const posmod = (value: number, modulus: number): number => ((value % modulus) + modulus) % modulus

export function gmstRad(unixSeconds: number): number {
  const jd = unixSeconds / 86400.0 + 2440587.5
  const t = (jd - 2451545.0) / 36525.0
  const seconds =
    67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t
  return (posmod(seconds, 86400.0) / 240.0) * (Math.PI / 180)
}
