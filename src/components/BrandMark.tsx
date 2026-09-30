import { useId } from 'react'

/** The official StreamLoom S-Play mark (same vector as the Android launcher icon). */
export function BrandMark({ size = 24 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="28 18 66 72" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="0" y1="22" x2="0" y2="86">
          <stop offset="0" stopColor="#00D4FF" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <path d="M37.75,24.77 Q33,22 33,27.5 L33,80.5 Q33,86 37.75,83.23 L83.25,56.77 Q88,54 83.25,51.23 Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <path fill={`url(#${id}g)`} fillRule="evenodd" d="M37.75,24.77 Q33,22 33,27.5 L33,80.5 Q33,86 37.75,83.23 L83.25,56.77 Q88,54 83.25,51.23 Z M52.5,40.03 h51 a4.5,4.5 0 0 1 4.5,4.5 v0 a4.5,4.5 0 0 1 -4.5,4.5 h-51 a4.5,4.5 0 0 1 -4.5,-4.5 v0 a4.5,4.5 0 0 1 4.5,-4.5 Z M-5.5,58.97 h64 a4.5,4.5 0 0 1 4.5,4.5 v0 a4.5,4.5 0 0 1 -4.5,4.5 h-64 a4.5,4.5 0 0 1 -4.5,-4.5 v0 a4.5,4.5 0 0 1 4.5,-4.5 Z" />
      </g>
    </svg>
  )
}
