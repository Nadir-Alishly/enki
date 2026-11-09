// Token use per Claude session, read from Claude Code's own transcripts and cached in SQLite.
// A response can appear on many transcript lines with the same usage, so each message ID counts once.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

export class TokenCache {
  constructor(path) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        session TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
        model TEXT, spent INTEGER NOT NULL, context INTEGER NOT NULL,
        PRIMARY KEY (session, id)
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages (session, at);
    `)
    this.paths = new Map()
  }

  /** Where a session's transcript is. Claude keeps one folder per working directory. */
  transcript(session) {
    if (this.paths.has(session)) return this.paths.get(session)
    const base = join(claudeDir(), 'projects')
    if (!existsSync(base)) return null
    for (const dir of readdirSync(base)) {
      const path = join(base, dir, `${session}.jsonl`)
      if (existsSync(path)) {
        this.paths.set(session, path)
        return path
      }
    }
    return null
  }

  /** Reads whatever the transcript gained since last time. Only complete lines are taken. */
  update(session) {
    const path = session && this.transcript(session)
    if (!path) return
    const size = statSync(path).size
    const row = this.db.prepare('SELECT offset FROM files WHERE path = ?').get(path)
    let offset = row?.offset ?? 0
    if (size < offset) offset = 0 // Rewritten: start over.
    if (size === offset) return
    const fd = openSync(path, 'r')
    const buffer = Buffer.alloc(size - offset)
    try {
      readSync(fd, buffer, 0, buffer.length, offset)
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf8')
    const end = text.lastIndexOf('\n')
    if (end === -1) return
    const upsert = this.db.prepare(`
      INSERT INTO messages (session, id, day, at, model, spent, context) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session, id) DO UPDATE SET spent = max(spent, excluded.spent), context = max(context, excluded.context), model = excluded.model
    `)
    this.db.exec('BEGIN')
    try {
      for (const line of text.slice(0, end).split('\n')) {
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        const message = entry.message
        const usage = message?.usage
        if (!usage || !message.id || !entry.timestamp) continue
        const input = usage.input_tokens ?? 0
        const written = usage.cache_creation_input_tokens ?? 0
        const read = usage.cache_read_input_tokens ?? 0
        const output = usage.output_tokens ?? 0
        const day = new Date(entry.timestamp).toLocaleDateString('sv-SE')
        upsert.run(session, message.id, day, entry.timestamp, message.model ?? null, input + written + output, input + written + read)
      }
      this.db.prepare('INSERT INTO files (path, offset) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET offset = excluded.offset').run(path, offset + Buffer.byteLength(text.slice(0, end + 1)))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Total spent, and the latest context size and model. */
  session(session) {
    if (!session) return null
    this.update(session)
    const total = this.db.prepare('SELECT sum(spent) AS spent, count(*) AS messages FROM messages WHERE session = ?').get(session)
    if (!total?.messages) return null
    const latest = this.db.prepare('SELECT context, model, at FROM messages WHERE session = ? ORDER BY at DESC LIMIT 1').get(session)
    return { spent: total.spent, context: latest.context, model: latest.model, at: latest.at }
  }

  /** Spent per local day for a session. */
  daily(session) {
    if (!session) return []
    this.update(session)
    return this.db.prepare('SELECT day, sum(spent) AS spent FROM messages WHERE session = ? GROUP BY day').all(session)
  }

  /** The transcript's size, so the server can tell when tokens changed without parsing. */
  size(session) {
    const path = session && this.transcript(session)
    try {
      return path ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

  close() {
    this.db.close()
  }
}
