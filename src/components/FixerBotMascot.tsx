/**
 * FixerBotMascot — the buffering-overlay robot, ported verbatim from the
 * Android/TV FixerBot character and choreography (see the FixerBot plan,
 * "Web parity" section) and from the animated prototype approved live during
 * that design pass (claude.ai Artifact VFzxVdTaYLdjwfK8sH4Fdy). The palette,
 * timing tables and easing below are intentionally identical to that
 * reference, not reinterpreted for this repo's own "Agate Black" theme
 * tokens (--accent/--accent-2) — the point is one recognizable mascot across
 * apps, not a per-app reskin.
 *
 * Perf note: every mutation below goes through a ref's setAttribute inside
 * the rAF loop, never React state — a re-render per frame here would be as
 * wasteful on low-end TV browsers as a Compose recomposition-per-frame is on
 * the Android side, which is exactly what that app's own animation
 * discipline avoids.
 */
import { useLayoutEffect, useRef } from 'react'
import type { AccessoryId } from '../api/occasion'
import './FixerBotMascot.css'

interface Props {
  accessory?: AccessoryId | null
}

const SLOW = 2.25
const LOOP = 8000 * SLOW

const RAW_SEG: Record<string, [number, number]> = {
  entrance: [0, 650],
  ratchet: [650, 1550],
  tellA: [1550, 1900],
  runAB: [1900, 2500],
  whack: [2500, 3550],
  tellB: [3550, 3850],
  runBC: [3850, 4650],
  listen: [4650, 5800],
  tellC: [5800, 6050],
  runCD: [6050, 6450],
  pry: [6450, 7550],
  tellD: [7550, 7850],
  hopDA: [7850, 8000],
}
const SEG: Record<string, [number, number]> = Object.fromEntries(
  Object.entries(RAW_SEG).map(([key, [start, end]]) => [key, [start * SLOW, end * SLOW]])
)

/** Units the body sinks while crouched, so the tool visibly reaches the ring's band. */
const BODY_DROP = 34
const STOP = { A: 0, B: 70, C: -75, D: -25 }
const CX = 220
const CY = 230
const R = 100

type Mood = 'content' | 'focused' | 'grumpy' | 'laugh' | 'surprised'
interface Arms {
  shL: number
  elL: number
  shR: number
  elR: number
  wrR: number
}
interface Pose {
  theta: number
  lean: number
  hop: number
  sy: number
  headTilt: number
  ant: number
  arms: Arms
  mood: Mood
  bulb: number
  spark: number
  wrenchOpacity: number
  legWiggle: number
}

const REST: Arms = { shL: 18, elL: -10, shR: -18, elR: 0, wrR: -25 }
const CLUTCH: Arms = { shL: 45, elL: -45, shR: -5, elR: 115, wrR: 35 }

function inSeg(t: number, name: string): boolean {
  const [start, end] = SEG[name]
  return t >= start && t < end
}
function prog(t: number, name: string): number {
  const [start, end] = SEG[name]
  return Math.min(1, Math.max(0, (t - start) / (end - start)))
}
function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p
}
function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3)
}
function easeOutBack(p: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
}

interface StrikeAngles {
  shL: number
  elL: number
  shR: number
  elR: number
  wrR: number
  shR2: number
  elR2: number
  wrR2: number
}

/** The three tool-strike actions (ratchet, whack) share this shape: a strike loop, then a triumphant flourish. */
function actionPose(
  t: number,
  segName: string,
  strike: StrikeAngles,
  freqStart: number,
  freqEnd: number
): { shL: number; elL: number; shR: number; elR: number; wrR: number; mood: Mood; bulb: number; spark: number; crouch: number } {
  const p = prog(t, segName)
  const [segStart, segEnd] = SEG[segName]
  const dur = segEnd - segStart
  const elapsed = t - segStart

  if (p > 0.86) {
    const tp = easeOutBack((p - 0.86) / 0.14)
    return {
      shL: lerp(REST.shL, 150, tp),
      elL: lerp(REST.elL, -20, tp),
      shR: lerp(strike.shR, -165, tp),
      elR: lerp(strike.elR, -10, tp),
      wrR: lerp(strike.wrR, 0, tp),
      mood: 'laugh',
      bulb: lerp(0.5, 1, tp),
      spark: 0,
      crouch: lerp(0.5, 0, tp),
    }
  }

  const freq = freqStart + (freqEnd - freqStart) * (elapsed / dur)
  const wave = (Math.sin((elapsed * freq) / 140) + 1) / 2
  const spark = wave > 0.93 ? (wave - 0.93) / 0.07 : 0
  return {
    shL: strike.shL,
    elL: strike.elL,
    shR: lerp(strike.shR, strike.shR2, wave),
    elR: lerp(strike.elR, strike.elR2, wave),
    wrR: lerp(strike.wrR, strike.wrR2, wave),
    mood: 'focused',
    bulb: 0.5,
    spark,
    crouch: 0.5,
  }
}

function computePose(t: number): Pose {
  let theta = 0
  let lean = 0
  let hop = 0
  let headTilt = 0
  let ant = 0
  let crouch = 0
  let arms: Arms = { ...REST }
  let mood: Mood = 'content'
  let bulb = 0.5
  let spark = 0
  let wrenchOpacity = 1
  let legWiggle = 0

  if (inSeg(t, 'entrance')) {
    const p = prog(t, 'entrance')
    theta = -35 + 35 * easeOutBack(Math.min(p, 1))
    lean = 14 * (1 - easeOutCubic(p))
    hop = 8 * Math.sin(p * Math.PI)
    legWiggle = 6 * Math.sin(p * 24)
    arms = {
      shL: lerp(CLUTCH.shL, REST.shL, p),
      elL: lerp(CLUTCH.elL, REST.elL, p),
      shR: lerp(CLUTCH.shR, REST.shR, p),
      elR: lerp(CLUTCH.elR, REST.elR, p),
      wrR: lerp(CLUTCH.wrR, REST.wrR, p),
    }
    mood = p < 0.8 ? 'surprised' : 'content'
  } else if (inSeg(t, 'ratchet')) {
    const r = actionPose(t, 'ratchet', { shL: 30, elL: -20, shR: -30, elR: 35, wrR: 40, shR2: -22, elR2: 65, wrR2: 40 }, 4, 8.5)
    arms = { shL: r.shL, elL: r.elL, shR: r.shR, elR: r.elR, wrR: r.wrR }
    mood = r.mood
    bulb = r.bulb
    spark = r.spark
    crouch = r.crouch
  } else if (inSeg(t, 'tellA')) {
    const p = prog(t, 'tellA')
    mood = p < 0.35 ? 'laugh' : p < 0.7 ? 'surprised' : 'grumpy'
    crouch = lerp(0, 0.25, p)
    headTilt = p > 0.7 ? 8 : 0
    arms = { ...REST }
  } else if (inSeg(t, 'runAB') || inSeg(t, 'runBC') || inSeg(t, 'runCD')) {
    const name = inSeg(t, 'runAB') ? 'runAB' : inSeg(t, 'runBC') ? 'runBC' : 'runCD'
    const from = name === 'runAB' ? STOP.A : name === 'runBC' ? STOP.B : STOP.C
    const to = name === 'runAB' ? STOP.B : name === 'runBC' ? STOP.C : STOP.D
    const dir = to > from ? 1 : -1
    const p = prog(t, name)
    const overshoot = easeOutBack(p)
    theta = from + (to - from) * overshoot
    lean = p < 0.75 ? 14 * dir * Math.min(p / 0.2, 1) : lerp(14 * dir, 0, (p - 0.75) / 0.25)
    hop = Math.abs(Math.sin((p * Math.PI * (name === 'runBC' ? 7 : 5)) / SLOW)) * 3
    legWiggle = 10 * Math.sin((p * (name === 'runBC' ? 60 : 40)) / SLOW)
    arms = { ...CLUTCH }
    mood = 'surprised'
    ant = -18 * dir * (1 - p * 0.5)
  } else if (inSeg(t, 'whack')) {
    const r = actionPose(t, 'whack', { shL: 35, elL: -30, shR: -150, elR: -50, wrR: -60, shR2: -35, elR2: 20, wrR2: -5 }, 4.5, 11.5)
    arms = { shL: r.shL, elL: r.elL, shR: r.shR, elR: r.elR, wrR: r.wrR }
    mood = r.mood
    bulb = r.bulb
    spark = r.spark
    crouch = r.crouch
  } else if (inSeg(t, 'tellB')) {
    const p = prog(t, 'tellB')
    mood = p < 0.4 ? 'surprised' : p < 0.75 ? 'grumpy' : 'focused'
    headTilt = 10 * Math.sin(p * Math.PI * 3)
    arms = { ...REST }
  } else if (inSeg(t, 'listen')) {
    const p = prog(t, 'listen')
    crouch = 0.8
    headTilt = -16
    if (p < 0.55) {
      arms = { shL: 5, elL: 0, shR: -10, elR: 80, wrR: 20 }
      wrenchOpacity = 0.15
      arms.shL += Math.sin(t * 9) * 2
      mood = 'focused'
      bulb = 0.5 + 0.5 * Math.sin(p * 30)
    } else if (p < 0.68) {
      const zp = (p - 0.55) / 0.13
      arms = { shL: lerp(5, 70, zp), elL: lerp(0, -90, zp), shR: -10, elR: 80, wrR: 20 }
      hop = 8 * Math.sin(zp * Math.PI)
      mood = 'surprised'
      spark = zp > 0.6 ? 1 : 0
      wrenchOpacity = 0.15
      crouch = lerp(0.8, 0.1, zp)
    } else {
      const sp = (p - 0.68) / 0.32
      arms = { shL: lerp(70, 18, Math.min(sp * 1.4, 1)), elL: lerp(-90, -10, Math.min(sp * 1.4, 1)), shR: -18, elR: 0, wrR: -25 }
      mood = sp < 0.6 ? 'grumpy' : 'focused'
      headTilt = lerp(-16, 0, sp)
      crouch = lerp(0.1, 0, sp)
    }
  } else if (inSeg(t, 'tellC')) {
    const p = prog(t, 'tellC')
    mood = 'laugh'
    bulb = lerp(0.6, 1, p)
    hop = 4 * Math.sin(p * Math.PI)
    arms = { shL: lerp(REST.shL, 160, p), elL: REST.elL, shR: REST.shR, elR: REST.elR, wrR: REST.wrR }
  } else if (inSeg(t, 'pry')) {
    const p = prog(t, 'pry')
    crouch = 1
    if (p < 0.7) {
      lean = Math.sin(t * 7) * 2
      arms = { shL: -25, elL: -30, shR: 20, elR: 30, wrR: -50 }
      mood = 'grumpy'
      headTilt = -8
    } else {
      const sp = (p - 0.7) / 0.3
      arms = {
        shL: lerp(-25, 120, easeOutBack(sp)),
        elL: lerp(-30, 0, sp),
        shR: lerp(20, -120, easeOutBack(sp)),
        elR: lerp(30, 0, sp),
        wrR: lerp(-50, 335, sp),
      }
      lean = lerp(0, -20, Math.min(sp * 1.5, 1))
      hop = 5 * Math.sin(sp * Math.PI)
      legWiggle = sp > 0.3 ? 12 * Math.sin(sp * 30) : 0
      mood = sp > 0.85 ? 'grumpy' : 'surprised'
      crouch = lerp(1, 0.2, sp)
    }
  } else if (inSeg(t, 'tellD')) {
    const p = prog(t, 'tellD')
    headTilt = 12 * Math.sin(p * Math.PI * 4) * (1 - p)
    mood = p < 0.8 ? 'grumpy' : 'focused'
    arms = { ...REST }
  } else if (inSeg(t, 'hopDA')) {
    const p = prog(t, 'hopDA')
    theta = lerp(STOP.D, STOP.A, easeOutBack(p))
    hop = 10 * Math.sin(p * Math.PI)
    const flingP = p < 0.5 ? p * 2 : (1 - p) * 2
    arms = { shL: lerp(REST.shL, 90, flingP), elL: REST.elL, shR: lerp(REST.shR, -90, flingP), elR: REST.elR, wrR: REST.wrR }
    mood = 'surprised'
  }

  return {
    theta,
    lean,
    hop: hop - crouch * BODY_DROP,
    sy: 1 - crouch * 0.06,
    headTilt,
    ant,
    arms,
    mood,
    bulb,
    spark,
    wrenchOpacity,
    legWiggle,
  }
}

/** A fixed point ~30% through the ratchet action: mid-crank, wrench on the band, mood focused. */
const REDUCED_MOTION_T = SEG.ratchet[0] + (SEG.ratchet[1] - SEG.ratchet[0]) * 0.3

const MOODS: Mood[] = ['content', 'focused', 'grumpy', 'laugh', 'surprised']

interface Refs {
  robotPos: SVGGElement | null
  robotLean: SVGGElement | null
  robotBody: SVGGElement | null
  legs: SVGGElement | null
  leftShoulder: SVGGElement | null
  leftElbow: SVGGElement | null
  rightShoulder: SVGGElement | null
  rightElbow: SVGGElement | null
  wrenchGroup: SVGGElement | null
  sparkGroup: SVGGElement | null
  headGroup: SVGGElement | null
  antennaGroup: SVGGElement | null
  bulb: SVGCircleElement | null
  faces: Record<Mood, SVGGElement | null>
}

function applyPose(refs: Refs, pose: Pose) {
  const rad = (pose.theta * Math.PI) / 180
  const x = CX + R * Math.sin(rad)
  const y = CY - R * Math.cos(rad)

  refs.robotPos?.setAttribute('transform', `translate(${x - 60},${y - 118})`)
  refs.robotLean?.setAttribute('transform', `rotate(${pose.lean} 60 118)`)
  refs.robotBody?.setAttribute(
    'transform',
    `translate(60,118) scale(${2 - pose.sy} ${pose.sy}) translate(-60,${-118 - pose.hop})`
  )
  refs.legs?.setAttribute('transform', `rotate(${pose.legWiggle} 60 100)`)
  refs.leftShoulder?.setAttribute('transform', `rotate(${pose.arms.shL} 36 68)`)
  refs.leftElbow?.setAttribute('transform', `rotate(${pose.arms.elL} 36 82)`)
  refs.rightShoulder?.setAttribute('transform', `rotate(${pose.arms.shR} 84 68)`)
  refs.rightElbow?.setAttribute('transform', `rotate(${pose.arms.elR} 84 82)`)
  refs.wrenchGroup?.setAttribute('transform', `translate(84 94) rotate(${pose.arms.wrR})`)
  refs.wrenchGroup?.setAttribute('opacity', String(pose.wrenchOpacity))
  refs.headGroup?.setAttribute('transform', `rotate(${pose.headTilt} 60 42)`)
  refs.antennaGroup?.setAttribute('transform', `rotate(${pose.ant} 60 16)`)
  refs.bulb?.setAttribute('fill', pose.bulb > 0.75 ? '#FFE08A' : pose.bulb > 0.4 ? '#FFC24A' : '#6E5630')
  refs.sparkGroup?.setAttribute('opacity', String(pose.spark))

  for (const mood of MOODS) {
    const el = refs.faces[mood]
    if (el) el.style.display = mood === pose.mood ? '' : 'none'
  }
}

function HeadAccessory({ accessory }: { accessory: AccessoryId | null | undefined }) {
  if (accessory === 'santa-hat') {
    return (
      <g transform="translate(60 10)">
        <path d="M-16 4 Q-16 -14 10 -14 Q4 -6 4 4 Z" fill="#D63C3C" stroke="#070A14" strokeWidth={1.6} />
        <circle cx={6} cy={-15} r={4} fill="#F1F3F8" stroke="#070A14" strokeWidth={1.2} />
        <rect x={-17} y={2} width={22} height={5} rx={2.5} fill="#F1F3F8" stroke="#070A14" strokeWidth={1.2} />
      </g>
    )
  }
  if (accessory === 'witch-hat') {
    return (
      <g transform="translate(60 8)">
        <path d="M-4 6 L4 -26 L14 6 Z" fill="#2E2140" stroke="#070A14" strokeWidth={1.6} />
        <ellipse cx={4} cy={6} rx={16} ry={4} fill="#3A2A54" stroke="#070A14" strokeWidth={1.4} />
        <rect x={-4} y={-2} width={16} height={4} fill="#FFC24A" />
      </g>
    )
  }
  if (accessory === 'party-hat') {
    return (
      <g transform="translate(60 10)">
        <path d="M-10 6 L10 6 L2 -22 Z" fill="#8B5CF6" stroke="#070A14" strokeWidth={1.6} />
        <circle cx={2} cy={-22} r={3} fill="#FFC24A" />
        <rect x={-10} y={4} width={20} height={4} fill="#00D4FF" />
      </g>
    )
  }
  return null
}

function ChestAccessory({ accessory }: { accessory: AccessoryId | null | undefined }) {
  if (accessory !== 'rosette') return null
  return (
    <g transform="translate(46 62)">
      <circle r={6} fill="#FF9F43" stroke="#070A14" strokeWidth={1.4} />
      <circle r={3} fill="#FFE08A" />
      <path d="M-2 5 L-5 14 L0 11 L5 14 L2 5 Z" fill="#FF9F43" stroke="#070A14" strokeWidth={1} />
    </g>
  )
}

function GroundAccessory({ accessory }: { accessory: AccessoryId | null | undefined }) {
  if (accessory !== 'diya') return null
  return (
    <g transform="translate(55 336)">
      <ellipse cx={0} cy={6} rx={16} ry={5} fill="#B5651D" stroke="#070A14" strokeWidth={1.4} />
      <ellipse cx={0} cy={2} rx={10} ry={3} fill="#D9861A" />
      <path className="fixerbot-diya-flame" d="M0 0 Q-2 -10 0 -14 Q2 -10 0 0 Z" fill="#FFC24A" />
    </g>
  )
}

export function FixerBotMascot({ accessory }: Props) {
  const robotPosRef = useRef<SVGGElement>(null)
  const robotLeanRef = useRef<SVGGElement>(null)
  const robotBodyRef = useRef<SVGGElement>(null)
  const legsRef = useRef<SVGGElement>(null)
  const leftShoulderRef = useRef<SVGGElement>(null)
  const leftElbowRef = useRef<SVGGElement>(null)
  const rightShoulderRef = useRef<SVGGElement>(null)
  const rightElbowRef = useRef<SVGGElement>(null)
  const wrenchGroupRef = useRef<SVGGElement>(null)
  const sparkGroupRef = useRef<SVGGElement>(null)
  const headGroupRef = useRef<SVGGElement>(null)
  const antennaGroupRef = useRef<SVGGElement>(null)
  const bulbRef = useRef<SVGCircleElement>(null)
  const faceContentRef = useRef<SVGGElement>(null)
  const faceFocusedRef = useRef<SVGGElement>(null)
  const faceGrumpyRef = useRef<SVGGElement>(null)
  const faceLaughRef = useRef<SVGGElement>(null)
  const faceSurprisedRef = useRef<SVGGElement>(null)

  useLayoutEffect(() => {
    const refs: Refs = {
      robotPos: robotPosRef.current,
      robotLean: robotLeanRef.current,
      robotBody: robotBodyRef.current,
      legs: legsRef.current,
      leftShoulder: leftShoulderRef.current,
      leftElbow: leftElbowRef.current,
      rightShoulder: rightShoulderRef.current,
      rightElbow: rightElbowRef.current,
      wrenchGroup: wrenchGroupRef.current,
      sparkGroup: sparkGroupRef.current,
      headGroup: headGroupRef.current,
      antennaGroup: antennaGroupRef.current,
      bulb: bulbRef.current,
      faces: {
        content: faceContentRef.current,
        focused: faceFocusedRef.current,
        grumpy: faceGrumpyRef.current,
        laugh: faceLaughRef.current,
        surprised: faceSurprisedRef.current,
      },
    }

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    let rafId: number | null = null

    function frame(now: number) {
      applyPose(refs, computePose(now % LOOP))
      rafId = requestAnimationFrame(frame)
    }

    function sync() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (mql.matches) {
        applyPose(refs, computePose(REDUCED_MOTION_T))
      } else {
        rafId = requestAnimationFrame(frame)
      }
    }

    sync()
    mql.addEventListener('change', sync)
    return () => {
      mql.removeEventListener('change', sync)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div className="fixerbot" aria-hidden="true">
      <svg className="fixerbot__svg" viewBox="0 0 440 360" role="presentation">
        <defs>
          <linearGradient id="fixerbot-pearl" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0.62" stopColor="#E4E9F4" />
            <stop offset="0.62" stopColor="#A9B3CD" />
          </linearGradient>
          <linearGradient id="fixerbot-blue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0.6" stopColor="#4F8EF7" />
            <stop offset="0.6" stopColor="#2A58BF" />
          </linearGradient>
          <linearGradient id="fixerbot-steel" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0.55" stopColor="#9CA7C6" />
            <stop offset="0.55" stopColor="#737E9D" />
          </linearGradient>
          <linearGradient id="fixerbot-visor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1A2748" />
            <stop offset="1" stopColor="#060A15" />
          </linearGradient>
          <linearGradient id="fixerbot-badge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#00D4FF" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>

        <g className="fixerbot-ring" style={{ transformOrigin: '220px 230px' }}>
          <circle cx={220} cy={230} r={100} fill="none" stroke="#4F8EF7" strokeWidth={18} strokeDasharray="171.7 456.6" strokeLinecap="round" />
          <circle cx={220} cy={230} r={100} fill="none" stroke="#00D4FF" strokeWidth={18} strokeDasharray="171.7 456.6" strokeDashoffset={-209.4} strokeLinecap="round" />
          <circle cx={220} cy={230} r={100} fill="none" stroke="#8B5CF6" strokeWidth={18} strokeDasharray="171.7 456.6" strokeDashoffset={-418.8} strokeLinecap="round" />
        </g>

        <GroundAccessory accessory={accessory} />

        <g ref={robotPosRef}>
          <g ref={robotLeanRef}>
            <g ref={robotBodyRef}>
              <ellipse cx={60} cy={120} rx={24} ry={4} fill="#000" opacity={0.25} />
              <g ref={legsRef}>
                <rect x={46} y={92} width={10} height={14} rx={3} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                <rect x={64} y={92} width={10} height={14} rx={3} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                <rect x={38} y={103} width={21} height={12} rx={5.5} fill="url(#fixerbot-blue)" stroke="#070A14" strokeWidth={2.2} />
                <rect x={61} y={103} width={21} height={12} rx={5.5} fill="url(#fixerbot-blue)" stroke="#070A14" strokeWidth={2.2} />
              </g>
              <g>
                <rect x={44} y={88} width={32} height={8} rx={3} fill="#262D48" stroke="#070A14" strokeWidth={1.8} />
                <rect x={38} y={61} width={44} height={32} rx={11} fill="url(#fixerbot-blue)" stroke="#070A14" strokeWidth={2.4} />
                <rect x={42.5} y={64.2} width={10} height={2.6} rx={1.3} fill="#A8C8FF" />
                <rect x={47} y={67} width={26} height={21} rx={5.5} fill="#0B1224" stroke="#070A14" strokeWidth={1.6} />
                <path
                  d="M56.56 70.9 L66.44 76.6 Q68 77.5 66.44 78.4 L56.56 84.1 Q55 85 55 83.2 L55 71.8 Q55 70 56.56 70.9 Z"
                  fill="url(#fixerbot-badge)"
                />
                <rect x={53} y={54} width={14} height={10} rx={2} fill="#262D48" stroke="#070A14" strokeWidth={1.8} />
                <ChestAccessory accessory={accessory} />
              </g>
              <g ref={leftShoulderRef}>
                <rect x={31.5} y={68} width={9} height={16} rx={4.5} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                <g ref={leftElbowRef}>
                  <rect x={32} y={82} width={8} height={13} rx={4} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                  <circle cx={36} cy={82} r={3.4} fill="#2E3656" stroke="#070A14" strokeWidth={1.4} />
                  <circle cx={36} cy={95} r={6} fill="url(#fixerbot-pearl)" stroke="#070A14" strokeWidth={2} />
                </g>
                <circle cx={36} cy={68} r={4.6} fill="#2E3656" stroke="#070A14" strokeWidth={1.6} />
              </g>
              <g ref={rightShoulderRef}>
                <rect x={79.5} y={68} width={9} height={16} rx={4.5} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                <g ref={rightElbowRef}>
                  <rect x={80} y={82} width={8} height={12} rx={4} fill="url(#fixerbot-steel)" stroke="#070A14" strokeWidth={2} />
                  <circle cx={84} cy={82} r={3.4} fill="#2E3656" stroke="#070A14" strokeWidth={1.4} />
                  <g ref={wrenchGroupRef}>
                    <path d="M-9 0 H19" stroke="#070A14" strokeWidth={7.6} strokeLinecap="round" fill="none" />
                    <path d="M27.6 4.1 A5.8 5.8 0 1 1 27.6 -4.1" stroke="#070A14" strokeWidth={7.4} strokeLinecap="round" fill="none" />
                    <path d="M-9 0 H19" stroke="#FFC24A" strokeWidth={4.6} strokeLinecap="round" fill="none" />
                    <path d="M27.6 4.1 A5.8 5.8 0 1 1 27.6 -4.1" stroke="#FFC24A" strokeWidth={4.4} strokeLinecap="round" fill="none" />
                    <g ref={sparkGroupRef} transform="translate(29 0)" opacity={0}>
                      <path d="M0,-9 L0,9 M-9,0 L9,0 M-6,-6 L6,6 M-6,6 L6,-6" stroke="#FFE08A" strokeWidth={2} strokeLinecap="round" />
                    </g>
                  </g>
                  <circle cx={84} cy={94} r={6} fill="url(#fixerbot-pearl)" stroke="#070A14" strokeWidth={2} />
                </g>
                <circle cx={84} cy={68} r={4.6} fill="#2E3656" stroke="#070A14" strokeWidth={1.6} />
              </g>
              <g ref={headGroupRef}>
                <rect x={23} y={29} width={7} height={15} rx={2.5} fill="url(#fixerbot-blue)" stroke="#070A14" strokeWidth={1.8} />
                <rect x={90} y={29} width={7} height={15} rx={2.5} fill="url(#fixerbot-blue)" stroke="#070A14" strokeWidth={1.8} />
                <g ref={antennaGroupRef}>
                  <path d="M60 16 V9" stroke="#070A14" strokeWidth={4.4} strokeLinecap="round" />
                  <path d="M60 16 V9" stroke="#9CA7C6" strokeWidth={2} strokeLinecap="round" />
                  <circle ref={bulbRef} cx={60} cy={7.5} r={4.2} fill="#FFC24A" stroke="#070A14" strokeWidth={2} />
                </g>
                <rect x={28} y={14} width={64} height={44} rx={15} fill="url(#fixerbot-pearl)" stroke="#070A14" strokeWidth={2.4} />
                <rect x={35} y={21} width={50} height={31} rx={10.5} fill="url(#fixerbot-visor)" stroke="#070A14" strokeWidth={1.8} />
                <g>
                  <g ref={faceContentRef}>
                    <rect x={46} y={28} width={8} height={10.5} rx={4} fill="#00D4FF" />
                    <rect x={66} y={28} width={8} height={10.5} rx={4} fill="#00D4FF" />
                    <path d="M52.5 42.5 Q60 49.5 67.5 42.5" stroke="#00D4FF" strokeWidth={3} strokeLinecap="round" fill="none" />
                  </g>
                  <g ref={faceFocusedRef} style={{ display: 'none' }}>
                    <rect x={46} y={31} width={8} height={7.5} rx={3} fill="#00D4FF" />
                    <rect x={66} y={32.6} width={8} height={5} rx={2.5} fill="#00D4FF" />
                    <path d="M53 44.6 L66.5 43.4" stroke="#00D4FF" strokeWidth={3} strokeLinecap="round" />
                  </g>
                  <g ref={faceGrumpyRef} style={{ display: 'none' }}>
                    <path d="M46 30.5 L54 33.5 V36.5 Q54 38.5 52 38.5 H48 Q46 38.5 46 36.5 Z" fill="#FF6B57" />
                    <path d="M74 30.5 L66 33.5 V36.5 Q66 38.5 68 38.5 H72 Q74 38.5 74 36.5 Z" fill="#FF6B57" />
                    <path
                      d="M50.5 43.5 Q60 40.2 69.5 43.5 V47.2 Q69.5 49.4 67.3 49.2 Q60 47.4 52.7 49.2 Q50.5 49.4 50.5 47.2 Z"
                      fill="#F1F3F8"
                      stroke="#FF6B57"
                      strokeWidth={1.6}
                      strokeLinejoin="round"
                    />
                  </g>
                  <g ref={faceLaughRef} style={{ display: 'none' }}>
                    <path d="M46 35.5 Q50 28 54 35.5 M66 35.5 Q70 28 74 35.5" stroke="#00D4FF" strokeWidth={3} strokeLinecap="round" fill="none" />
                    <path d="M49.5 40.5 H70.5 Q70.5 51 60 51 Q49.5 51 49.5 40.5 Z" fill="#3B0D2A" />
                    <path d="M51 41.4 H69 V43.4 Q60 44.6 51 43.4 Z" fill="#F1F3F8" />
                  </g>
                  <g ref={faceSurprisedRef} style={{ display: 'none' }}>
                    <circle cx={50} cy={33} r={5} fill="#00D4FF" />
                    <circle cx={70} cy={33} r={5} fill="#00D4FF" />
                    <ellipse cx={60} cy={45.2} rx={3.2} ry={3.6} fill="#0B1224" stroke="#00D4FF" strokeWidth={2.4} />
                  </g>
                </g>
                <HeadAccessory accessory={accessory} />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  )
}
