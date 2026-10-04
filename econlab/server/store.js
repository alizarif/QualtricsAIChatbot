// JSON-file persistence. The whole database lives in memory (a lab session is
// small: kilobytes per participant) and is written atomically, debounced, so a
// crash can never leave a half-written file.

import fs from 'node:fs';
import path from 'node:path';
import { attachRuntime } from './engine.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'db.json') : null;
    this.db = { version: 1, experiments: {}, sessions: {} };
    this.participantIndex = new Map(); // participant code -> {sessionId, id}
    this.sessionCodeIndex = new Map(); // join code -> session id
    this.timer = null;
    this.lastBackup = 0;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.load();
    }
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      const bad = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, bad);
      throw new Error(`Could not read ${this.file} (${e.message}). A copy was saved to ${bad}. Restore db.json.bak or remove the file to start fresh.`);
    }
    this.db = { version: 1, experiments: raw.experiments ?? {}, sessions: raw.sessions ?? {} };
    for (const s of Object.values(this.db.sessions)) { attachRuntime(s); this.indexSession(s); }
  }

  indexSession(s) {
    this.sessionCodeIndex.set(s.code, s.id);
    for (const p of s.participants) this.participantIndex.set(p.code, { sessionId: s.id, id: p.id });
  }

  unindexSession(s) {
    this.sessionCodeIndex.delete(s.code);
    for (const p of s.participants) this.participantIndex.delete(p.code);
  }

  hasParticipantCode(code) { return this.participantIndex.has(code); }

  findParticipant(code) {
    const hit = this.participantIndex.get(code);
    if (!hit) return null;
    const session = this.db.sessions[hit.sessionId];
    if (!session) return null;
    return { session, participant: session.participants[hit.id - 1] };
  }

  findSessionByCode(code) {
    const id = this.sessionCodeIndex.get(code);
    return id ? this.db.sessions[id] : null;
  }

  dirty() {
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 700);
    this.timer.unref?.();
  }

  flush() {
    if (!this.dir) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    const now = Date.now();
    if (fs.existsSync(this.file) && now - this.lastBackup > 10 * 60 * 1000) {
      fs.copyFileSync(this.file, `${this.file}.bak`);
      this.lastBackup = now;
    }
    fs.renameSync(tmp, this.file);
  }
}
