import { useEffect, useRef, useState } from 'react'

/** How far ahead of the viewport an element counts as visible, so its data is ready by the time it scrolls in. */
const ROOT_MARGIN = '200px'

/**
 * One shared IntersectionObserver for every caller, instead of one per element.
 * A grid or a horizontal row can mount hundreds of cards; a per-card observer
 * is hundreds of native objects for something a single instance already does.
 */
let observer: IntersectionObserver | null = null
const onVisible = new WeakMap<Element, () => void>()

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          onVisible.get(entry.target)?.()
          observer!.unobserve(entry.target)
          onVisible.delete(entry.target)
        }
      },
      { rootMargin: ROOT_MARGIN },
    )
  }
  return observer
}

/**
 * True once the ref'd element has entered (or nearly entered) the viewport; stays
 * true after. Used to gate lazy work — an EPG fetch, in particular — to elements
 * a viewer is actually about to see, not everything a list happens to mount.
 */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible) return
    const el = ref.current
    const obs = sharedObserver()
    if (!el || !obs) {
      setVisible(true)
      return
    }
    onVisible.set(el, () => setVisible(true))
    obs.observe(el)
    return () => {
      obs.unobserve(el)
      onVisible.delete(el)
    }
  }, [visible])

  return [ref, visible]
}
