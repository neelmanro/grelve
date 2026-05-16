"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"

type WaveformProps = {
  isListening: boolean
  /** When set, visualizes this stream instead of calling getUserMedia (parent owns track lifecycle). */
  mediaStream?: MediaStream | null
  barCount?: number
  className?: string
  barClassName?: string
  sensitivity?: number
}

export default function Waveform({
  isListening,
  mediaStream = null,
  barCount = 92,
  className = "",
  barClassName = "",
  sensitivity = 2.2,
}: WaveformProps) {
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: barCount }, () => 12))

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ownsStreamRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const timeRef = useRef(0)
  const lastLevelsRef = useRef<number[]>(Array.from({ length: barCount }, () => 12))

  const indexes = useMemo(() => Array.from({ length: barCount }, (_, i) => i), [barCount])

  useEffect(() => {
    let cancelled = false

    function attachAnalyser(stream: MediaStream, weOwnStream: boolean) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const audioContext = new AudioContextClass()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()

      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.82

      source.connect(analyser)

      streamRef.current = stream
      ownsStreamRef.current = weOwnStream
      audioContextRef.current = audioContext
      analyserRef.current = analyser
    }

    async function startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        attachAnalyser(stream, true)
      } catch {
        analyserRef.current = null
      }
    }

    function stopMic() {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }

      if (streamRef.current && ownsStreamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      streamRef.current = null
      ownsStreamRef.current = false

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {})
        audioContextRef.current = null
      }

      analyserRef.current = null
    }

    function animate() {
      timeRef.current += 0.045

      const analyser = analyserRef.current
      const nextBars = new Array(barCount).fill(0)

      if (isListening && analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)

        const usableBins = Math.floor(data.length * 0.42)
        const binsPerBar = Math.max(1, Math.floor(usableBins / barCount))

        for (let i = 0; i < barCount; i++) {
          let sum = 0
          const start = i * binsPerBar
          const end = Math.min(start + binsPerBar, usableBins)

          for (let j = start; j < end; j++) {
            sum += data[j]
          }

          const average = sum / Math.max(1, end - start)
          const soundHeight = Math.pow(average / 255, 0.72) * 48 * sensitivity
          const idlePulse = 7 + Math.sin(timeRef.current * 2.1 + i * 0.42) * 5
          const centerBoost = 1 + (1 - Math.abs(i - barCount / 2) / (barCount / 2)) * 0.55
          const target = Math.min(66, Math.max(5, (idlePulse + soundHeight) * centerBoost))
          const previous = lastLevelsRef.current[i] ?? 8

          nextBars[i] = previous * 0.62 + target * 0.38
        }
      } else {
        for (let i = 0; i < barCount; i++) {
          const center = 1 - Math.abs(i - barCount / 2) / (barCount / 2)
          const waveA = Math.sin(timeRef.current * 2.6 + i * 0.34)
          const waveB = Math.sin(timeRef.current * 1.35 + i * 0.16)
          const target = 9 + waveA * 5 + waveB * 3 + center * 12
          const previous = lastLevelsRef.current[i] ?? 8

          nextBars[i] = previous * 0.82 + Math.max(4, target) * 0.18
        }
      }

      lastLevelsRef.current = nextBars
      setBars(nextBars)
      frameRef.current = requestAnimationFrame(animate)
    }

    if (isListening && mediaStream) {
      attachAnalyser(mediaStream, false)
    } else if (isListening && !mediaStream) {
      startMic()
    }

    animate()

    return () => {
      cancelled = true
      stopMic()
    }
  }, [isListening, mediaStream, barCount, sensitivity])

  return (
    <div
      className={`flex min-h-[56px] h-14 w-full items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-white px-3 shadow-[0_1px_0_rgba(10,10,10,0.04)] sm:px-5 ${className}`}
    >
      <div className="flex h-full w-full min-w-0 items-center justify-center gap-[2px] sm:gap-[3px]">
        {indexes.map(index => {
          const height = bars[index] ?? 8

          return (
            <span
              key={index}
              className={`block w-[3px] rounded-full bg-neutral-600 transition-[background-color] duration-200 ${barClassName}`}
              style={{
                height: `${height}px`,
                opacity: 0.35 + Math.min(height / 70, 0.55),
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
