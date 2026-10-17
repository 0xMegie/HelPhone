export type AlertPosition = {
  distanceKm?: number
  bearingDegrees?: number
}

type AudioContextConstructor = typeof AudioContext

export class EmergencyAudioAlert {
  private context: AudioContext | null = null

  private getAudioContext(): AudioContext {
    if (this.context) return this.context

    const Context = window.AudioContext as AudioContextConstructor | undefined
    if (!Context) throw new Error('Web Audio is not supported in this browser.')
    this.context = new Context()
    return this.context
  }

  async play(position: AlertPosition = {}): Promise<void> {
    const context = this.getAudioContext()
    if (context.state === 'suspended') await context.resume()

    const distance = Math.max(0, position.distanceKm ?? 0)
    const attenuation = Math.max(0.2, 1 / (1 + distance / 5))
    const bearing = ((position.bearingDegrees ?? 0) % 360 + 360) % 360
    const pan = Math.sin((bearing * Math.PI) / 180)
    const now = context.currentTime
    const gain = context.createGain()
    const panner = context.createStereoPanner()
    panner.pan.setValueAtTime(pan, now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(0.22 * attenuation, now + 0.08)
    gain.gain.setValueAtTime(0.22 * attenuation, now + 0.52)
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.62)
    panner.connect(gain)
    gain.connect(context.destination)

    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(720, now)
    oscillator.frequency.linearRampToValueAtTime(980, now + 0.28)
    oscillator.frequency.linearRampToValueAtTime(720, now + 0.56)
    oscillator.connect(panner)
    oscillator.start(now)
    oscillator.stop(now + 0.64)
    oscillator.onended = () => {
      oscillator.disconnect()
      panner.disconnect()
      gain.disconnect()
    }
  }

  async unlock(): Promise<void> {
    const context = this.getAudioContext()
    if (context.state === 'suspended') await context.resume()
  }

  async close(): Promise<void> {
    if (this.context && this.context.state !== 'closed') await this.context.close()
    this.context = null
  }
}

export const emergencyAudioAlert = new EmergencyAudioAlert()
