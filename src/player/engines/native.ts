/** Plain progressive playback through the video element (MP4/M4V). */
export interface NativeCallbacks {
  onMediaBytes: () => void
  onPlaying: () => void
  onError: () => void
}

export function startNativeEngine(video: HTMLVideoElement, url: string, cb: NativeCallbacks): () => void {
  video.src = url
  // Only a buffer that actually grew counts as media arriving.
  let bufferedEnd = 0
  video.onprogress = () => {
    const b = video.buffered
    const end = b.length > 0 ? b.end(b.length - 1) : 0
    if (end > bufferedEnd) {
      bufferedEnd = end
      cb.onMediaBytes()
    }
  }
  video.onloadedmetadata = () => {
    video.play().catch(() => {})
  }
  video.onplaying = cb.onPlaying
  video.onerror = cb.onError
  return () => {
    video.onprogress = null
    video.onloadedmetadata = null
    video.onplaying = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
  }
}
