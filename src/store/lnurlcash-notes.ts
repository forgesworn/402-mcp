import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { getOrCreateKey, encrypt, decrypt, isEncrypted } from './encryption.js'

/**
 * - `live`        spendable, the mint recognises it
 * - `provisional` written to disk before the split that creates it was sent,
 *                 so a crash mid-split can't strand value at a hash whose
 *                 preimage was never persisted. Resolved against the mint.
 * - `melting`     handed to a melt whose outcome isn't known yet. Held back
 *                 from spending until the mint says whether it burned.
 */
export type NoteState = 'live' | 'provisional' | 'melting'

export interface StoredNote {
  /**
   * The bearer secret (LUD-25 `k1`), 64 hex chars. This IS the money: anyone
   * holding it can spend the note. Never log it, never put it in an error.
   */
  secret: string
  /** Base URL of the mint that honours this note. */
  mint: string
  amountMsat: number
  state: NoteState
  addedAt: string
  /** For a provisional note, the secret of the note whose split created it. */
  parent?: string
  /**
   * For a melting note, the mint's LUD-21 verify URL for the invoice being
   * paid, and that invoice's payment hash.
   *
   * Written before the first poll rather than kept in a local variable,
   * because losing it loses the payment. A melt that settles after the
   * client stops waiting still spends the note; without this the only route
   * back to the preimage is gone, and for L402 the preimage is not a
   * receipt, it is the credential being bought. So: sats gone, note gone,
   * no access, and no way to ask again.
   */
  verifyUrl?: string
  paymentHashHex?: string
}

/**
 * A melt this wallet paid for, kept after the note itself is gone.
 *
 * The preimage is the thing the payment bought. Reconciling a melt that
 * settled late has to put it somewhere durable, or recovering it and then
 * dropping it on the floor is the same outcome as never recovering it.
 */
export interface SettledMelt {
  paymentHashHex: string
  preimage: string
  amountMsat: number
  mint: string
  settledAt: string
}

interface NoteStoreData {
  notes: StoredNote[]
  /** Melts recovered after the fact. Absent in files written before this. */
  settledMelts?: SettledMelt[]
}

/** Encrypted persistent store for LNURLcash bearer notes. */
export class LnurlcashNoteStore {
  private data: NoteStoreData = { notes: [] }
  private key: Buffer | null = null

  constructor(private readonly path: string) {}

  /** Initialises the encryption key and loads persisted notes. */
  async init(): Promise<{ keySource: 'keychain' | 'file' }> {
    const result = await getOrCreateKey()
    this.key = result.key
    this.load()
    return { keySource: result.source }
  }

  list(): StoredNote[] {
    return [...this.data.notes]
  }

  /** Spendable notes only, largest last. */
  live(): StoredNote[] {
    return this.data.notes.filter(n => n.state === 'live')
  }

  byState(state: NoteState): StoredNote[] {
    return this.data.notes.filter(n => n.state === state)
  }

  find(secret: string): StoredNote | undefined {
    return this.data.notes.find(n => n.secret === secret)
  }

  /** Total spendable value. Notes mid-split or mid-melt deliberately excluded. */
  totalBalanceMsat(): number {
    return this.live().reduce((sum, n) => sum + n.amountMsat, 0)
  }

  add(note: StoredNote): void {
    this.data.notes.push(note)
    this.save()
  }

  /**
   * Adds several notes in one write. Used to persist both sides of a split
   * before the split request goes out, so there is no window where only one
   * child secret survives a crash.
   */
  addMany(notes: StoredNote[]): void {
    if (notes.length === 0) return
    this.data.notes.push(...notes)
    this.save()
  }

  setState(secret: string, state: NoteState): void {
    const note = this.find(secret)
    if (!note || note.state === state) return
    note.state = state
    this.save()
  }

  setAmount(secret: string, amountMsat: number): void {
    const note = this.find(secret)
    if (!note || note.amountMsat === amountMsat) return
    note.amountMsat = amountMsat
    this.save()
  }

  /** Promotes a provisional note to spendable with its confirmed value. */
  confirm(secret: string, amountMsat: number): void {
    const note = this.find(secret)
    if (!note) return
    note.state = 'live'
    note.amountMsat = amountMsat
    delete note.parent
    this.save()
  }

  remove(secret: string): void {
    const before = this.data.notes.length
    this.data.notes = this.data.notes.filter(n => n.secret !== secret)
    if (this.data.notes.length !== before) this.save()
  }

  /** Melts whose preimage was recovered, newest last. */
  settledMelts(): SettledMelt[] {
    return [...(this.data.settledMelts ?? [])]
  }

  /**
   * Records a recovered preimage. Idempotent on payment hash: reconcile can
   * run many times over the same late melt, and a duplicate here would look
   * like a second payment.
   */
  recordSettledMelt(melt: SettledMelt): void {
    const existing = this.data.settledMelts ?? []
    if (existing.some(m => m.paymentHashHex === melt.paymentHashHex)) return
    this.data.settledMelts = [...existing, melt]
    this.save()
  }

  /** Attaches the proof a late melt can be recovered with, before polling starts. */
  setMeltProof(secret: string, verifyUrl: string, paymentHashHex: string): void {
    const note = this.find(secret)
    if (!note) return
    note.verifyUrl = verifyUrl
    note.paymentHashHex = paymentHashHex
    this.save()
  }

  removeMany(secrets: string[]): void {
    if (secrets.length === 0) return
    const drop = new Set(secrets)
    const before = this.data.notes.length
    this.data.notes = this.data.notes.filter(n => !drop.has(n.secret))
    if (this.data.notes.length !== before) this.save()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      if (isEncrypted(raw)) {
        const json = decrypt(raw, this.key!)
        const parsed = JSON.parse(json) as NoteStoreData
        this.data = Array.isArray(parsed.notes) ? parsed : { notes: [] }
      } else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as NoteStoreData).notes)) {
        // Legacy plaintext; migrate to encrypted on next write.
        this.data = raw as NoteStoreData
        this.save()
      } else {
        this.data = { notes: [] }
      }
    } catch { this.data = { notes: [] } }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* Windows safety net */ }
    }
    const json = JSON.stringify(this.data, null, 2)
    const content = this.key
      ? JSON.stringify(encrypt(json, this.key), null, 2)
      : json

    const tmpPath = this.path + '.tmp'
    writeFileSync(tmpPath, content, { mode: 0o600 })
    renameSync(tmpPath, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows safety net */ }
  }
}
