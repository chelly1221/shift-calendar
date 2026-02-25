import { type CSSProperties, useEffect, useMemo, useState } from 'react'
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
    })
  }

  return engineInitPromise
}

interface RainDrop {
  id: string
  bottomPercent: number
  offsetPercent: number
  delaySeconds: number
  durationSeconds: number
}

interface RainRows {
  front: RainDrop[]
  back: RainDrop[]
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

function createRainRows(): RainRows {
  let increment = 0
  let index = 0
  const front: RainDrop[] = []
  const back: RainDrop[] = []

  while (increment < 100) {
    const randoHundo = randomBetween(1, 98)
    const randoFiver = randomBetween(2, 5)
    increment += randoFiver

    const drop: RainDrop = {
      id: `${index}-${increment}-${randoHundo}`,
      offsetPercent: increment,
      bottomPercent: randoFiver + randoFiver - 1 + 100,
      delaySeconds: Number(`0.${randoHundo}`),
      durationSeconds: Number(`0.5${randoHundo}`),
    }

    front.push(drop)
    back.push({ ...drop, id: `back-${drop.id}` })
    index += 1
  }

  return { front, back }
}

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

export function WeatherOverlay({ mode }: WeatherOverlayProps) {
  const [isReady, setIsReady] = useState(false)
  const [rainRows, setRainRows] = useState<RainRows>(() => createRainRows())

  useEffect(() => {
    let disposed = false

    void ensureParticlesEngine().then(() => {
      if (!disposed) {
        setIsReady(true)
      }
    })

    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (mode !== 'rain') {
      return
    }
    setRainRows(createRainRows())
  }, [mode])

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
        <div className="weather-rain weather-rain-front-row">
          {rainRows.front.map((drop) => {
            const dropStyle: CSSProperties = {
              left: `${drop.offsetPercent}%`,
              bottom: `${drop.bottomPercent}%`,
              animationDelay: `${drop.delaySeconds}s`,
              animationDuration: `${drop.durationSeconds}s`,
            }
            const childStyle: CSSProperties = {
              animationDelay: `${drop.delaySeconds}s`,
              animationDuration: `${drop.durationSeconds}s`,
            }

            return (
              <div key={drop.id} className="weather-rain-drop" style={dropStyle}>
                <div className="weather-rain-stem" style={childStyle} />
                <div className="weather-rain-splat" style={childStyle} />
              </div>
            )
          })}
        </div>
        <div className="weather-rain weather-rain-back-row">
          {rainRows.back.map((drop) => {
            const dropStyle: CSSProperties = {
              right: `${drop.offsetPercent}%`,
              bottom: `${drop.bottomPercent}%`,
              animationDelay: `${drop.delaySeconds}s`,
              animationDuration: `${drop.durationSeconds}s`,
            }
            const childStyle: CSSProperties = {
              animationDelay: `${drop.delaySeconds}s`,
              animationDuration: `${drop.durationSeconds}s`,
            }

            return (
              <div key={drop.id} className="weather-rain-drop" style={dropStyle}>
                <div className="weather-rain-stem" style={childStyle} />
                <div className="weather-rain-splat" style={childStyle} />
              </div>
            )
          })}
        </div>
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
