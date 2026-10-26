// Servidor de la Oficina de Skills: API REST + WebSocket + archivos estáticos.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HOST, PORT, ROOT_DIR, WORKSPACE_DIR, PERMISSION_MODE } from './config.js';
import { SkillRegistry } from './skills.js';
import { Store, uid } from './store.js';
import { runClaude, systemPromptFor, firstPromptFor } from './claude.js';

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const store = new Store().load();
const registry = new SkillRegistry();
const jobs = new Map(); // skillId -> { cancel, startedAt, tool }

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function snapshot() {
  return {
    director: store.data.director,
    skills: registry.list(),
    proposals: store.data.proposals,
    jobs: [...jobs.entries()].map(([skillId, j]) => ({ skillId, startedAt: j.startedAt, tool: j.tool })),
  };
}

function updateProposal(proposal, changes) {
  Object.assign(proposal, changes, { updatedAt: Date.now() });
  store.save();
  broadcast('proposal', { proposal });
}

// Envía un mensaje del Director a una skill y, al terminar, deja la respuesta
// como propuesta en la bandeja del Director.
function sendToSkill(skill, text) {
  const conv = store.conversation(skill.id);

  // Lo que hubiera pendiente de esta skill queda contestado con este mensaje.
  for (const p of store.data.proposals) {
    if (p.skillId === skill.id && p.status === 'pendiente') updateProposal(p, { status: 'respondida' });
  }

  const directorMsg = { id: uid(), role: 'director', text, ts: Date.now() };
  conv.messages.push(directorMsg);
  store.save();
  broadcast('message', { skillId: skill.id, message: directorMsg });

  const run = runClaude({
    prompt: conv.sessionId ? text : firstPromptFor(skill, text),
    sessionId: conv.sessionId,
    systemPrompt: systemPromptFor(skill, store.data.director),
    onDelta: (delta) => broadcast('job:delta', { skillId: skill.id, delta }),
    onTool: (tool) => {
      const job = jobs.get(skill.id);
      if (job) job.tool = tool;
      broadcast('job:tool', { skillId: skill.id, tool });
    },
  });
  jobs.set(skill.id, { cancel: run.cancel, startedAt: Date.now(), tool: null });
  broadcast('job:start', { skillId: skill.id });

  run.done.then(({ text: reply, sessionId, isError }) => {
    jobs.delete(skill.id);
    // Si falla una sesión retomada, se olvida para que la próxima empiece limpia.
    conv.sessionId = isError ? null : sessionId;

    if (isError) {
      const errMsg = { id: uid(), role: 'sistema', text: reply || 'Error desconocido.', ts: Date.now() };
      conv.messages.push(errMsg);
      broadcast('message', { skillId: skill.id, message: errMsg });
    } else {
      const proposal = {
        id: uid(),
        skillId: skill.id,
        skillName: skill.name,
        text: reply,
        status: 'pendiente',
        feedback: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const skillMsg = { id: uid(), role: 'skill', text: reply, ts: Date.now(), proposalId: proposal.id };
      conv.messages.push(skillMsg);
      store.data.proposals.push(proposal);
      broadcast('message', { skillId: skill.id, message: skillMsg });
      broadcast('proposal', { proposal });
    }
    store.save();
    broadcast('job:end', { skillId: skill.id, isError });
  });
}

function requireSkill(req, res) {
  const skill = registry.get(req.params.skillId);
  if (!skill) res.status(404).json({ error: 'Esa skill no está en la oficina.' });
  return skill;
}

function requireIdle(skill, res) {
  if (!jobs.has(skill.id)) return true;
  res.status(409).json({ error: `«${skill.name}» está trabajando; espera a que termine.` });
  return false;
}

// --- API ---------------------------------------------------------------------

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/api/skills', (_req, res) => res.json(registry.list()));

app.put('/api/director', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'El nombre no puede estar vacío.' });
  store.data.director = name;
  store.save();
  broadcast('director', { director: name });
  res.json({ director: name });
});

app.get('/api/conversations/:skillId', (req, res) => {
  const conv = store.data.conversations[req.params.skillId];
  res.json(conv ?? { sessionId: null, messages: [] });
});

app.post('/api/conversations/:skillId/messages', (req, res) => {
  const skill = requireSkill(req, res);
  if (!skill || !requireIdle(skill, res)) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje está vacío.' });
  sendToSkill(skill, text);
  res.status(202).json({ ok: true });
});

app.post('/api/conversations/:skillId/cancel', (req, res) => {
  const job = jobs.get(req.params.skillId);
  if (!job) return res.status(404).json({ error: 'No hay ningún trabajo en curso.' });
  job.cancel();
  res.json({ ok: true });
});

// Archiva la conversación actual y empieza una sesión nueva con la skill.
app.post('/api/conversations/:skillId/reset', (req, res) => {
  const skill = requireSkill(req, res);
  if (!skill || !requireIdle(skill, res)) return;
  store.data.conversations[skill.id] = { sessionId: null, messages: [] };
  store.save();
  broadcast('conversation:reset', { skillId: skill.id });
  res.json({ ok: true });
});

// Decisiones del Director sobre una propuesta.
app.post('/api/proposals/:id/:action', (req, res) => {
  const proposal = store.proposal(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Propuesta no encontrada.' });
  const note = String(req.body?.note || '').trim();
  const { action } = req.params;

  if (action === 'archivar') {
    updateProposal(proposal, { status: 'archivada' });
    return res.json({ proposal });
  }

  if (action !== 'aprobar' && action !== 'rechazar') {
    return res.status(400).json({ error: `Acción desconocida: ${action}` });
  }
  if (action === 'rechazar' && !note) {
    return res.status(400).json({ error: 'Explica a la skill por qué rechazas la propuesta.' });
  }

  const skill = registry.get(proposal.skillId);
  if (!skill) return res.status(410).json({ error: 'La skill ya no está en la oficina.' });
  if (!requireIdle(skill, res)) return;

  const message = action === 'aprobar'
    ? `✅ El Director APRUEBA tu propuesta. Procede con ella.${note ? `\n\nIndicaciones: ${note}` : ''}`
    : `❌ El Director RECHAZA tu propuesta.\n\nMotivo: ${note}\n\nPrepara una nueva propuesta teniendo esto en cuenta.`;

  sendToSkill(skill, message);
  updateProposal(proposal, { status: action === 'aprobar' ? 'aprobada' : 'rechazada', feedback: note || null });
  res.json({ proposal });
});

// --- Arranque ------------------------------------------------------------------

wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'snapshot', ...snapshot() })));

// El primer escaneo ocurre dentro de start(), antes de escuchar cambios, para
// no anunciar como «nuevas» las skills que ya estaban.
registry.start();
registry.on('change', ({ added, removed }) => {
  if (added.length) console.log(`[skills] Nuevas en la oficina: ${added.join(', ')}`);
  if (removed.length) console.log(`[skills] Se han ido: ${removed.join(', ')}`);
  broadcast('skills', { skills: registry.list(), added, removed });
});

server.listen(PORT, HOST, () => {
  console.log(`🏢 Oficina de Skills abierta en http://${HOST}:${PORT}`);
  console.log(`   ${registry.list().length} skills en plantilla · permisos: ${PERMISSION_MODE}`);
});

function shutdown() {
  for (const job of jobs.values()) job.cancel();
  registry.stop();
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
