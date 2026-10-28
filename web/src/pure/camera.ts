/**
 * pure/camera.ts — Pure camera math.
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

/**
 * Compute spherical orbit delta from relative camera position and mouse deltas.
 * Returns the new camera position offset relative to the orbit target.
 */
export function sphericalOrbitDelta(
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
): { x: number; y: number; z: number } {
  const r = Math.sqrt(px * px + py * py + pz * pz)
  const theta = Math.atan2(px, pz) - dx * 0.005
  const phi = Math.acos(py / r) - dy * 0.005
  const clampedPhi = Math.max(0.01, Math.min(Math.PI - 0.01, phi))
  return {
    x: r * Math.sin(clampedPhi) * Math.sin(theta),
    y: r * Math.cos(clampedPhi),
    z: r * Math.sin(clampedPhi) * Math.cos(theta),
  }
}

/** Pan delta in world space given camera position, orbit target, and mouse deltas */
export function panDelta(
  cameraPos: { x: number; y: number; z: number },
  orbitTarget: { x: number; y: number; z: number },
  dx: number,
  dy: number,
  k = 0.03,
): { x: number; y: number; z: number } {
  const fx = orbitTarget.x - cameraPos.x
  const fy = orbitTarget.y - cameraPos.y
  const fz = orbitTarget.z - cameraPos.z
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz)
  const forward = { x: fx / fl, y: fy / fl, z: fz / fl }
  const rx = forward.z
  const ry = 0
  const rz = -forward.x
  const rl = Math.sqrt(rx * rx + rz * rz) || 1
  const right = { x: rx / rl, y: ry, z: rz / rl }
  const ux = forward.y * right.z - forward.z * right.y
  const uy = forward.z * right.x - forward.x * right.z
  const uz = forward.x * right.y - forward.y * right.x
  return {
    x: (dx * right.x + dy * ux) * k,
    y: (dx * right.y + dy * uy) * k,
    z: (dx * right.z + dy * uz) * k,
  }
}

/** Convert camera position (relative to orbit target) to spherical angles and zoom */
export function cameraToSpherical(
  camera: { position: { x: number; y: number; z: number }; zoom?: number },
  orbitTarget: { x: number; y: number; z: number },
): { yawDeg: number; elevationDeg: number; zoom: number } | null {
  const px = camera.position.x - orbitTarget.x
  const py = camera.position.y - orbitTarget.y
  const pz = camera.position.z - orbitTarget.z
  const r = Math.sqrt(px * px + py * py + pz * pz)
  if (r < 1e-6) return null

  const yawDeg = Math.round(Math.atan2(px, pz) * 180 / Math.PI)
  const phi = Math.acos(Math.max(-1, Math.min(1, py / r)))
  const elevationDeg = Math.round(90 - phi * 180 / Math.PI)
  const zoom = Math.round((camera.zoom ?? 1) * 100) / 100
  return { yawDeg, elevationDeg, zoom }
}
