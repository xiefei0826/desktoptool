import type { K8sWatchEvent } from '@shared/types'

type Handler = (event: K8sWatchEvent) => void

const handlers = new Map<string, Handler>()

export function registerK8sWatch(watchId: string, handler: Handler): () => void {
  handlers.set(watchId, handler)
  return () => {
    if (handlers.get(watchId) === handler) handlers.delete(watchId)
  }
}

export function dispatchK8sWatch(event: K8sWatchEvent): void {
  handlers.get(event.watchId)?.(event)
}
