// Persistencia en un fichero JSON (data/state.json): nombre del Director,
// conversaciones por skill y propuestas de la bandeja.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, DEFAULT_DIRECTOR } from './config.js';

const FILE = path.join(DATA_DIR, 'state.json');
const SAVE_DEBOUNCE_MS = 250;

export const uid = () => crypto.randomUUID();

export class Store {
  constructor() {
    this.data = { director: DEFAULT_DIRECTOR, conversations: {}, proposals: [] };
    this.timer = null;
  }

  load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
      } catch (err) {
        console.warn(`[store] state.json ilegible, se empieza de cero: ${err.message}`);
      }
    }
    return this;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  // Escritura atómica: fichero temporal + rename.
  flush() {
    clearTimeout(this.timer);
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, FILE);
  }

  conversation(skillId) {
    this.data.conversations[skillId] ??= { sessionId: null, messages: [] };
    return this.data.conversations[skillId];
  }

  proposal(id) {
    return this.data.proposals.find((p) => p.id === id);
  }
}
