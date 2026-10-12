import type { NostrEvent } from 'nostr-tools/core'
import { parseStorageAnnouncement } from '402-announce/storage'

/** Prevent malformed storage metadata from being interpreted as a generic paid API. */
export function claimsStorage(event: NostrEvent): boolean {
  if (event.tags.some(t => (t[0] === 't' && t[1] === 'forgesworn-storage-service-v1') || (t[0] === 'pmi' && t[1] === 'wildbloom-checkout'))) return true
  try {
    const value: unknown = JSON.parse(event.content)
    return value !== null && typeof value === 'object' && Object.hasOwn(value,'storage')
  } catch { return false }
}

/** Validate storage claims before replacement, retain unavailable watermarks, and bound session memory. */
export function updateAnnouncements(prior: Map<string,NostrEvent>, incoming: NostrEvent[], now: number): Map<string,NostrEvent> {
  if (incoming.length > 1000) throw new Error('Announcement response limit exceeded.')
  const next = new Map(prior)
  for (const event of incoming) {
    if (claimsStorage(event)) { try { parseStorageAnnouncement(event,{now}) } catch { continue } }
    const key = `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] ?? ''}`
    const existing = next.get(key)
    if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) next.set(key,event)
  }
  if (next.size > 2000) throw new Error('Announcement session memory limit exceeded.')
  return next
}

/** Wildbloom storage needs bound NIP-98 quotes and a separate explicit customer checkout. */
export function unsupportedStorageCheckout() {
  return {content:[{type:'text' as const,text:JSON.stringify({error:'Wildbloom checkout is not supported by the automatic paid-API tools. Review /services/v1 and use Wildbloom’s explicit private quote/payment flow. Free shelter supports authorised mirrors only.',paymentFlow:'wildbloom-checkout-v1',autoPaySupported:false})}],isError:true as const}
}
