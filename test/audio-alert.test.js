import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmergencyAudioAlert } from '../src/lib/audioAlert.ts'

function makeAudioContext() {
  const param = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  const node = { connect: vi.fn(), disconnect: vi.fn(), pan: param, gain: param, frequency: param,
    start: vi.fn(), stop: vi.fn(), type: '', onended: null }
  return {
    state: 'running', currentTime: 10, destination: {},
    createGain: vi.fn(() => ({ ...node })),
    createStereoPanner: vi.fn(() => ({ ...node })),
    createOscillator: vi.fn(() => ({ ...node })),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
}

describe('EmergencyAudioAlert', () => {
  const previousAudioContext = window.AudioContext
  afterEach(() => {
    window.AudioContext = previousAudioContext
    vi.restoreAllMocks()
  })

  it('synthesizes an alert and pans according to bearing', async () => {
    const context = makeAudioContext()
    window.AudioContext = vi.fn(() => context)
    const alert = new EmergencyAudioAlert()

    await alert.play({ distanceKm: 5, bearingDegrees: 90 })

    expect(context.createOscillator).toHaveBeenCalledOnce()
    const panner = context.createStereoPanner.mock.results[0].value
    expect(panner.pan.setValueAtTime).toHaveBeenCalledWith(1, 10)
  })

  it('resumes a suspended context from the user gesture path', async () => {
    const context = makeAudioContext()
    context.state = 'suspended'
    window.AudioContext = vi.fn(() => context)
    const alert = new EmergencyAudioAlert()

    await alert.unlock()

    expect(context.resume).toHaveBeenCalledOnce()
  })
})
