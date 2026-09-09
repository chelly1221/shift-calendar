/** A developable cylindrical fold travelling from the bottom corner across the sheet. */
export function curlPagePoint(x: number, y: number, width: number, height: number, progress: number, previous = false) {
  const px = previous ? width - x : x
  const nx = 0.88, ny = Math.sqrt(1 - nx * nx)
  const radius = Math.min(width, height) * (0.065 + 0.035 * Math.sin(Math.PI * progress))
  const corner = nx * width + ny * height
  const crease = corner + 1 - (corner + 1 + Math.PI * radius + width * 0.25) * progress
  const distance = nx * px + ny * y - crease
  if (distance <= 0) return { x, y, z: 0, nx: 0, ny: 0, nz: 1 }
  const angle = Math.min(Math.PI, distance / radius)
  const folded = distance < Math.PI * radius ? radius * Math.sin(angle) : -(distance - Math.PI * radius)
  const delta = folded - distance
  const bentX = px + nx * delta
  return {
    x: previous ? width - bentX : bentX, y: y + ny * delta,
    z: radius * (1 - Math.cos(angle)),
    nx: (previous ? 1 : -1) * nx * Math.sin(angle), ny: -ny * Math.sin(angle), nz: Math.cos(angle),
  }
}
