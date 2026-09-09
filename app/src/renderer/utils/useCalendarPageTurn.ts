import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { createPageCurl, PAGE_CURL_MARGIN } from './pageCurlCanvas'

async function snapshot(rect: DOMRect): Promise<HTMLImageElement | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const load = async () => {
      const source = await window.windowApi.captureCalendar({
        x: Math.max(0, Math.ceil(rect.x)), y: Math.max(0, Math.ceil(rect.y)),
        width: Math.floor(rect.width), height: Math.floor(rect.height),
      })
      const image = new Image()
      image.src = source
      await image.decode()
      return image
    }
    // Navigation must still work immediately if capture is unavailable or slow.
    return await Promise.race([load(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 350) })])
  } catch { return null } finally { clearTimeout(timer) }
}

export function useCalendarPageTurn(panel: RefObject<HTMLElement>) {
  const cleanupRef = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const clear = () => cleanupRef.current?.()
    const invalidatePending = () => { generation.current++ }
    window.addEventListener('resize', clear)
    window.addEventListener('scroll', clear, true)
    return () => {
      invalidatePending()
      clear()
      window.removeEventListener('resize', clear)
      window.removeEventListener('scroll', clear, true)
    }
  }, [])

  return useCallback(async (direction: 'next' | 'prev', navigate: () => void) => {
    const token = ++generation.current
    cleanupRef.current?.()
    const calendar = panel.current?.querySelector<HTMLElement>(':scope > .fc')
    const bounds = calendar?.getBoundingClientRect()
    if (!calendar || !bounds?.width || !bounds.height || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate()
      return
    }
    const image = await snapshot(bounds)
    if (token !== generation.current) return
    const current = calendar.getBoundingClientRect()
    const mesh = image && current.width === bounds.width && current.height === bounds.height
      ? createPageCurl(image, bounds.width, bounds.height, direction === 'prev') : null
    try { navigate() } catch (error) { mesh?.dispose(); throw error }
    if (!mesh) return
    const layer = document.createElement('div')
    layer.className = `calendar-page-turn calendar-page-turn--${direction}`
    layer.setAttribute('aria-hidden', 'true'); layer.inert = true
    Object.assign(layer.style, { left: `${bounds.left - PAGE_CURL_MARGIN}px`, top: `${bounds.top - PAGE_CURL_MARGIN}px` })
    layer.append(mesh.canvas)
    document.body.append(layer)
    let frame = 0, disposed = false
    const cleanup = () => {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frame); clearTimeout(deadline)
      layer.remove(); mesh.dispose()
      if (cleanupRef.current === cleanup) cleanupRef.current = null
    }
    const deadline = setTimeout(cleanup, 1200)
    cleanupRef.current = cleanup
    mesh.canvas.addEventListener('webglcontextlost', cleanup, { once: true })
    const started = performance.now()
    const render = (time: number) => {
      if (disposed) return
      const elapsed = Math.min(1, Math.max(0, (time - started) / 820))
      const progress = elapsed * elapsed * (3 - 2 * elapsed)
      layer.dataset.progress = progress.toFixed(3)
      mesh.render(progress)
      if (elapsed < 1) frame = requestAnimationFrame(render)
      else cleanup()
    }
    mesh.render(0)
    frame = requestAnimationFrame(render)
  }, [panel])
}
