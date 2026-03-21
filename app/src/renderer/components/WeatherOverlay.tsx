import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Particles, { initParticlesEngine } from '@tsparticles/react'
import { loadSlim } from '@tsparticles/slim'
import { loadSnowPreset } from '@tsparticles/preset-snow'
import type { ISourceOptions } from '@tsparticles/engine'

export type WeatherOverlayMode = 'none' | 'rain' | 'snow'

interface WeatherOverlayProps {
  mode: WeatherOverlayMode
}

let engineInitPromise: Promise<void> | null = null

function ensureParticlesEngine(): Promise<void> {
  if (!engineInitPromise) {
    engineInitPromise = initParticlesEngine(async (engine) => {
      await loadSlim(engine)
      await loadSnowPreset(engine)
    }).catch((err) => {
      engineInitPromise = null
      throw err
    })
  }

  return engineInitPromise
}

/* ── Canvas Rain ── */

interface CanvasRainDrop {
  x: number
  y: number
  vy: number
  length: number
  width: number
  opacity: number
  z: number // 0‑1 depth for parallax
}

interface Splash {
  x: number
  y: number
  radius: number
  maxRadius: number
  opacity: number
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function createDrop(canvasW: number, canvasH: number): CanvasRainDrop {
  const z = Math.random()
  return {
    x: Math.random() * canvasW,
    y: -rand(0, canvasH),
    vy: rand(6, 10) * (0.5 + z * 0.5),
    length: rand(20, 35) * (0.5 + z * 0.5),
    width: rand(2.5, 4.5) * (0.4 + z * 0.6),
    opacity: rand(0.35, 0.7) * (0.4 + z * 0.6),
    z,
  }
}

const DROP_COUNT = 90
const GRAVITY = 0.12
const SPLASH_FADE = 0.03
const SPLASH_GROW = 1.2

function RainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dropsRef = useRef<CanvasRainDrop[]>([])
  const splashesRef = useRef<Splash[]>([])
  const rafRef = useRef<number>(0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      // re-init drops on resize
      dropsRef.current = Array.from({ length: DROP_COUNT }, () => createDrop(w, h))
    }

    // motion blur: fade previous frame instead of clearing
    ctx.save()
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
    ctx.fillRect(0, 0, w, h)
    ctx.restore()

    const drops = dropsRef.current
    const splashes = splashesRef.current

    // update & draw drops
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i]
      d.vy += GRAVITY
      d.y += d.vy

      // draw stem with round caps
      ctx.beginPath()
      ctx.moveTo(d.x, d.y)
      ctx.lineTo(d.x, d.y - d.length)
      ctx.strokeStyle = `rgba(173, 216, 240, ${d.opacity})`
      ctx.lineWidth = d.width
      ctx.lineCap = 'round'
      ctx.stroke()

      // hit bottom → splash & reset
      if (d.y > h) {
        splashes.push({
          x: d.x,
          y: h,
          radius: 1,
          maxRadius: rand(8, 16) * (0.5 + d.z * 0.5),
          opacity: d.opacity * 1.2,
        })
        Object.assign(d, createDrop(w, h))
        d.y = -rand(0, 80)
      }
    }

    // update & draw splashes
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i]
      s.radius *= SPLASH_GROW
      s.opacity -= SPLASH_FADE

      if (s.opacity <= 0 || s.radius > s.maxRadius) {
        splashes.splice(i, 1)
        continue
      }

      ctx.beginPath()
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(173, 216, 240, ${s.opacity})`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    dropsRef.current = Array.from({ length: DROP_COUNT }, () => createDrop(w, h))

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  )
}

/* ── Snow Options ── */

const SNOW_OPTIONS: ISourceOptions = {
  preset: 'snow',
  fullScreen: { enable: false },
  detectRetina: true,
  fpsLimit: 120,
  background: {
    color: { value: 'transparent' },
  },
  particles: {
    number: {
      value: 190,
      density: {
        enable: true,
        width: 1920,
        height: 1080,
      },
    },
    color: {
      value: ['#ffffff', '#e8f7ff', '#b8e4ff'],
    },
    shadow: {
      enable: true,
      color: '#8ba8c7',
      blur: 6,
      offset: {
        x: 0,
        y: 0,
      },
    },
    opacity: {
      value: { min: 0.42, max: 0.95 },
    },
    size: {
      value: { min: 1.8, max: 7.2 },
    },
    move: {
      enable: true,
      direction: 'bottom',
      speed: { min: 1.2, max: 4.4 },
      random: true,
      straight: false,
      outModes: {
        default: 'out',
      },
    },
  },
}

/* ── Main Component ── */

export function WeatherOverlay({ mode }: WeatherOverlayProps) {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    let disposed = false

    void ensureParticlesEngine()
      .then(() => {
        if (!disposed) {
          setIsReady(true)
        }
      })
      .catch((err) => {
        console.error('[WeatherOverlay] Particles engine init failed:', err)
      })

    return () => {
      disposed = true
    }
  }, [])

  const options = useMemo(() => {
    if (mode === 'snow') {
      return SNOW_OPTIONS
    }
    return null
  }, [mode])

  if (mode === 'none') {
    return null
  }

  if (mode === 'rain') {
    return (
      <div className="weather-overlay weather-overlay-rain" aria-hidden="true">
        <RainCanvas />
      </div>
    )
  }

  if (!isReady || !options) {
    return null
  }

  return (
    <div className="weather-overlay weather-overlay-snow" aria-hidden="true">
      <Particles
        id="weather-overlay-snow"
        className="weather-overlay-canvas"
        style={{ position: 'absolute', inset: 0 }}
        options={options}
      />
    </div>
  )
}
