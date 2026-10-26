// Registro de skills: localiza los SKILL.md instalados, los mantiene en memoria
// y avisa (evento "change") cada vez que aparece, cambia o desaparece una skill.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CLAUDE_DIR, EXTRA_SKILL_DIRS } from './config.js';

const MAX_DEPTH = 8;
const RESCAN_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 15_000;

// Carpetas donde Claude Code guarda skills. "plugins/marketplaces" se excluye a
// propósito: contiene el catálogo de plugins disponibles, no los instalados.
function skillRoots() {
  return [
    { dir: path.join(CLAUDE_DIR, 'skills'), origin: 'personal' },
    { dir: path.join(CLAUDE_DIR, 'plugins', 'cache'), origin: 'plugin' },
    { dir: path.join(CLAUDE_DIR, 'plugins', 'synced'), origin: 'plugin' },
    ...EXTRA_SKILL_DIRS.map((dir) => ({ dir, origin: 'extra' })),
  ];
}

// Lector mínimo del frontmatter YAML de un SKILL.md (claves simples, cadenas
// entrecomilladas y bloques ">" / "|"), suficiente para name y description.
export function parseFrontmatter(src) {
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[>|][-+]?$/.test(val)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        block.push(lines[++i].trim());
      }
      val = block.join(val[0] === '>' ? ' ' : '\n').trim();
    } else if (val.length > 1 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1).replace(/''/g, "'");
    } else if (val.length > 1 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    out[key] = val;
  }
  return out;
}

function findSkillFiles(dir, depth = 0, acc = []) {
  if (depth > MAX_DEPTH) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    }
    if (isDir) findSkillFiles(full, depth + 1, acc);
    else if (entry.name === 'SKILL.md') acc.push(full);
  }
  return acc;
}

// Nombre del plugin dueño de una skill: se busca el .claude-plugin/plugin.json
// más cercano subiendo desde la carpeta de la skill.
function pluginNameFor(file, root) {
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(manifest)) {
      try { return JSON.parse(fs.readFileSync(manifest, 'utf8')).name || path.basename(dir); } catch { return path.basename(dir); }
    }
    dir = path.dirname(dir);
  }
  const parts = path.relative(root, file).split(path.sep);
  const idx = parts.lastIndexOf('skills');
  return idx > 0 ? parts[idx - 1] : null;
}

function readSkill(file, root) {
  let src, stat;
  try {
    src = fs.readFileSync(file, 'utf8');
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const meta = parseFrontmatter(src);
  const name = meta.name || path.basename(path.dirname(file));
  let origin = root.origin;
  if (origin === 'personal' && file.includes(`${path.sep}synced${path.sep}`)) origin = 'claude.ai';
  const plugin = origin === 'plugin' ? pluginNameFor(file, root.dir) : null;
  return {
    id: plugin ? `${plugin}:${name}` : name,
    name,
    plugin,
    origin,
    description: meta.description || '',
    path: file,
    updatedAt: stat.mtimeMs,
  };
}

export class SkillRegistry extends EventEmitter {
  constructor() {
    super();
    this.skills = new Map();
    this.watchers = [];
    this.timer = null;
  }

  list() {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    return this.skills.get(id);
  }

  scan() {
    const next = new Map();
    for (const root of skillRoots()) {
      for (const file of findSkillFiles(root.dir)) {
        const skill = readSkill(file, root);
        if (!skill) continue;
        // Si la misma skill existe en varias rutas (p. ej. varias versiones de
        // un plugin en caché), gana la más reciente.
        const prev = next.get(skill.id);
        if (!prev || prev.updatedAt < skill.updatedAt) next.set(skill.id, skill);
      }
    }

    const added = [...next.keys()].filter((id) => !this.skills.has(id));
    const removed = [...this.skills.keys()].filter((id) => !next.has(id));
    const changed = [...next.keys()].filter(
      (id) => this.skills.has(id) && this.skills.get(id).updatedAt !== next.get(id).updatedAt,
    );
    this.skills = next;
    if (added.length || removed.length || changed.length) {
      this.emit('change', { added, removed, changed });
    }
  }

  scheduleScan() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.scan(), RESCAN_DEBOUNCE_MS);
  }

  // Vigila las carpetas con fs.watch (recursivo) para reaccionar al instante,
  // y además re-escanea periódicamente por si alguna carpeta aún no existía.
  start() {
    this.scan();
    const watchTargets = new Set([CLAUDE_DIR, ...skillRoots().map((r) => r.dir)]);
    for (const dir of watchTargets) {
      if (!fs.existsSync(dir)) continue;
      try {
        const recursive = dir !== CLAUDE_DIR;
        this.watchers.push(fs.watch(dir, { recursive }, () => this.scheduleScan()));
      } catch (err) {
        console.warn(`[skills] No se pudo vigilar ${dir}: ${err.message}`);
      }
    }
    this.poller = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  stop() {
    this.watchers.forEach((w) => w.close());
    clearInterval(this.poller);
    clearTimeout(this.timer);
  }
}
