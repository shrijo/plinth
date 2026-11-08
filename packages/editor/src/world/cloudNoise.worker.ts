/// <reference lib="webworker" />
import { makeCloudNoise } from '@plinth/world'

/** Makes the clouds' noise textures off the main thread (a third of a second's work). */
declare const self: DedicatedWorkerGlobalScope

self.onmessage = () => {
  const noise = makeCloudNoise(64, 32)
  self.postMessage(noise, [noise.shape.buffer, noise.detail.buffer])
}
