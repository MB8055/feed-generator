import { Database } from '../db'

// Jetstream (https://github.com/bluesky-social/jetstream) delivers pre-filtered,
// JSON-encoded repo events. Filtering server-side with `wantedCollections` means we
// only download posts, instead of the entire network firehose.

export type JetstreamCommit = {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: any
  cid?: string
}

export type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: JetstreamCommit
}

// Node 22+ ships a global WebSocket, but the installed @types/node (20) doesn't declare it.
const WS: any = (globalThis as any).WebSocket

const WANTED_COLLECTIONS = ['app.bsky.feed.post']
// Rewind a little on reconnect so events in flight when the socket dropped are replayed.
const CURSOR_REWIND_US = 5_000_000
const CURSOR_SAVE_INTERVAL_MS = 5_000
const STATS_INTERVAL_MS = 60_000

export abstract class FirehoseSubscriptionBase {
  private lastCursorSave = 0
  private bytes = 0
  private events = 0

  constructor(public db: Database, public service: string) {
    if (!WS) {
      throw new Error('global WebSocket not available; Node 22+ is required')
    }
  }

  abstract handleEvent(evt: JetstreamEvent): Promise<void>

  async run(subscriptionReconnectDelay: number) {
    setInterval(() => {
      console.log(
        `[stats] last minute: ${this.events} events, ${(this.bytes / 1048576).toFixed(2)} MB received`,
      )
      this.bytes = 0
      this.events = 0
    }, STATS_INTERVAL_MS).unref()
    this.connect(subscriptionReconnectDelay)
  }

  private async connect(reconnectDelay: number) {
    const params = new URLSearchParams()
    for (const c of WANTED_COLLECTIONS) params.append('wantedCollections', c)
    const { cursor } = await this.getCursor()
    if (cursor) params.set('cursor', String(Math.max(cursor - CURSOR_REWIND_US, 0)))

    const url = `${this.service.replace(/\/$/, '')}/subscribe?${params}`
    console.log(`connecting to ${url}`)
    const ws = new WS(url)

    ws.onmessage = (msg: { data: unknown }) => {
      const raw = typeof msg.data === 'string' ? msg.data : String(msg.data)
      this.bytes += Buffer.byteLength(raw)
      this.events++
      let evt: JetstreamEvent
      try {
        evt = JSON.parse(raw)
      } catch (err) {
        console.error('jetstream skipped unparseable message', err)
        return
      }
      this.handleEvent(evt).catch((err) => {
        console.error('jetstream could not handle message', err)
      })
      const now = Date.now()
      if (evt.time_us && now - this.lastCursorSave > CURSOR_SAVE_INTERVAL_MS) {
        this.lastCursorSave = now
        this.updateCursor(evt.time_us).catch((err) =>
          console.error('could not save cursor', err),
        )
      }
    }
    ws.onerror = (err: any) => {
      console.error('jetstream socket error', err?.message ?? err)
    }
    ws.onclose = () => {
      console.error(`jetstream closed, reconnecting in ${reconnectDelay}ms`)
      setTimeout(() => this.connect(reconnectDelay), reconnectDelay)
    }
  }

  async updateCursor(cursor: number) {
    await this.db
      .insertInto('sub_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor }))
      .execute()
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    return res ? { cursor: res.cursor } : {}
  }
}
