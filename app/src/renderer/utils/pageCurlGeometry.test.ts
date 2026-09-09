import { describe, expect, it } from 'vitest'
import { curlPagePoint } from './pageCurlGeometry'

describe('corner page curl', () => {
  it('starts with the original flat calendar and lifts the lower right corner first', () => {
    expect(curlPagePoint(1000, 800, 1000, 800, 0)).toEqual({ x: 1000, y: 800, z: 0, nx: 0, ny: 0, nz: 1 })
    expect(curlPagePoint(1000, 800, 1000, 800, 0.12).z).toBeGreaterThan(20)
    expect(curlPagePoint(1000, 0, 1000, 800, 0.12).z).toBe(0)
    expect(curlPagePoint(0, 800, 1000, 800, 0.12).z).toBe(0)
  })
  it('mirrors the curl for previous-month navigation', () => {
    const next = curlPagePoint(900, 720, 1000, 800, 0.3)
    const prev = curlPagePoint(100, 720, 1000, 800, 0.3, true)
    expect(prev.x).toBeCloseTo(1000 - next.x)
    expect(prev.y).toBeCloseTo(next.y); expect(prev.z).toBeCloseTo(next.z)
    expect(prev.nx).toBeCloseTo(-next.nx)
  })
  it('keeps every sampled surface normal finite and unit length through the fold', () => {
    for (const progress of [0, 0.01, 0.25, 0.5, 0.75, 1]) for (let x = 0; x <= 1000; x += 50) for (let y = 0; y <= 800; y += 50) {
      const p = curlPagePoint(x, y, 1000, 800, progress)
      expect(Object.values(p).every(Number.isFinite)).toBe(true)
      expect(Math.hypot(p.nx, p.ny, p.nz)).toBeCloseTo(1)
      expect(p.z).toBeGreaterThanOrEqual(0)
    }
  })
})
