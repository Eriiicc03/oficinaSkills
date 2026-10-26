// Cliente de la Oficina de Skills: dibuja el edificio, mantiene el estado en
// vivo vía WebSocket y gestiona los chats y la bandeja del Director.

const OFFICES_PER_FLOOR = 4;

const state = {
  connected: false,
  director: 'Director',
  skills: [],
  proposals: [],
  jobs: new Map(), // skillId -> { tool, live }
  conversations: new Map(), // skillId -> mensajes (solo las ya abiertas)
  arrived: new Set(), // skills recién llegadas, para animarlas una vez
  open: null, // { type: 'skill', id } | { type: 'inbox' }
  inboxFilter: 'pendiente',
};

const $ = (sel, root = document) => root.querySelector(sel);
const building = $('#building');
const panel = $('#panel');
const panelBody = $('#panel-body');

// --- Utilidades --------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Markdown mínimo y seguro (se escapa todo antes de dar formato).
function md(src) {
  const parts = String(src).split(/```[\w-]*\n?([\s\S]*?)```/g);
  return parts.map((part, i) => (i % 2 ? `<pre><code>${esc(part)}</code></pre>` : mdBlocks(esc(part)))).join('');
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdBlocks(s) {
  let html = '';
  let inList = false;
  for (const line of s.split('\n')) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${mdInline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) html += `<h4>${mdInline(h[1])}</h4>`;
    else if (line.trim()) html += `${mdInline(line)}<br>`;
    else html += '<br>';
  }
  return inList ? `${html}</ul>` : html;
}

const time = (ts) => new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const ICONS = [
  [/pdf/, '📄'], [/docx|word|doc/, '📝'], [/pptx|slide|present/, '📊'], [/xlsx|excel|sheet/, '📈'],
  [/google|drive|workspace/, '🗂️'], [/memory|memoria/, '🧠'], [/morning|brief/, '☀️'],
  [/skill-creator|creator/, '🛠️'], [/plugin/, '🧩'], [/shop|dropship|tienda/, '🛒'],
  [/design|figma|art/, '🎨'], [/code|dev|git/, '💻'], [/mail|gmail/, '✉️'], [/calendar/, '📅'],
];
const WORKERS = ['🧑‍💼', '👩‍💼', '👨‍💼', '🧑‍💻', '👩‍💻', '👨‍💻', '🧑‍🔬', '👩‍🎨', '🧑‍🏫', '🕵️'];
function avatarFor(skill) {
  const hit = ICONS.find(([re]) => re.test(skill.id.toLowerCase()));
  if (hit) return hit[1];
  let h = 0;
  for (const c of skill.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return WORKERS[h % WORKERS.length];
}

const ORIGIN_LABEL = { personal: 'Personal', 'claude.ai': 'claude.ai', plugin: 'Plugin', extra: 'Externa' };
const originLabel = (s) => (s.plugin ? `Plugin · ${s.plugin}` : ORIGIN_LABEL[s.origin] || s.origin);

const pendingFor = (skillId) => state.proposals.filter((p) => p.skillId === skillId && p.status === 'pendiente').length;
const totalPending = () => state.proposals.filter((p) => p.status === 'pendiente').length;

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// --- Edificio ------------------------------------------------------------------

function renderBuilding() {
  const floors = [];
  for (let i = 0; i < state.skills.length; i += OFFICES_PER_FLOOR) {
    floors.push(state.skills.slice(i, i + OFFICES_PER_FLOOR));
  }
  if (!floors.length) floors.push([]);

  const pending = totalPending();
  let html = `
    <div class="roof"><div class="sign">OFICINA <b>SKILLS</b></div></div>
    <div class="floor penthouse">
      <div class="floor-label">Ático</div>
      <button class="office director lit" type="button" data-inbox>
        <div class="avatar big">👔</div>
        <div>
          <div class="director-title">Dirección</div>
          <div class="director-name-big">${esc(state.director)}</div>
        </div>
        <div class="director-pending">${pending ? `📥 ${pending} propuesta${pending === 1 ? '' : 's'} pendiente${pending === 1 ? '' : 's'}` : 'Bandeja al día ✔'}</div>
        ${pending ? `<span class="badge">${pending}</span>` : ''}
      </button>
    </div>`;

  for (let f = floors.length - 1; f >= 0; f--) {
    const slots = [...floors[f]];
    while (slots.length < OFFICES_PER_FLOOR) slots.push(null);
    html += `<div class="floor"><div class="floor-label">Planta ${f + 1}</div>${slots.map(officeHtml).join('')}</div>`;
  }

  const working = state.jobs.size;
  html += `
    <div class="floor lobby">
      <div class="lobby-info">
        <b>Recepción</b><br>
        ${state.skills.length} skill${state.skills.length === 1 ? '' : 's'} en plantilla<br>
        ${working ? `${working} trabajando ahora` : 'Todo el mundo disponible'}
      </div>
      <div class="door"></div>
      <div></div>
    </div>`;

  building.innerHTML = html;
  state.arrived.clear();
}

function officeHtml(skill) {
  if (!skill) {
    return '<div class="office empty"><div class="office-name">Se alquila</div><div class="office-origin">Despacho libre</div></div>';
  }
  const job = state.jobs.get(skill.id);
  const pending = pendingFor(skill.id);
  const classes = ['office', 'lit'];
  if (job) classes.push('working');
  if (pending) classes.push('pending');
  if (state.arrived.has(skill.id)) classes.push('arrived');
  return `
    <button class="${classes.join(' ')}" type="button" data-skill="${esc(skill.id)}" title="${esc(skill.description.slice(0, 300))}">
      <div class="office-top">
        <div class="avatar">${avatarFor(skill)}</div>
        <span class="typing"><i></i><i></i><i></i></span>
        <span class="lamp"></span>
      </div>
      <div>
        <div class="office-name">${esc(skill.id)}</div>
        <div class="office-origin">${esc(originLabel(skill))}</div>
      </div>
      ${pending ? `<span class="badge">${pending}</span>` : ''}
    </button>`;
}

function renderTopbar() {
  const conn = $('#conn');
  conn.className = `conn ${state.connected ? 'on' : 'off'}`;
  conn.textContent = state.connected ? '● En línea' : '● Desconectado';
  const pending = totalPending();
  const badge = $('#inbox-count');
  badge.hidden = !pending;
  badge.textContent = pending;
  document.title = pending ? `(${pending}) Oficina de Skills` : 'Oficina de Skills';
}

function render() {
  renderTopbar();
  renderBuilding();
  if (state.open?.type === 'inbox') renderInbox();
  if (state.open?.type === 'skill') renderChatState();
}

building.addEventListener('click', (e) => {
  const office = e.target.closest('[data-skill]');
  if (office) openSkill(office.dataset.skill);
  else if (e.target.closest('[data-inbox]')) openInbox();
});
$('#inbox-btn').addEventListener('click', openInbox);
$('#panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

function closePanel() {
  state.open = null;
  panel.hidden = true;
  panelBody.replaceChildren();
}

// --- Chat con una skill --------------------------------------------------------

async function openSkill(id) {
  const skill = state.skills.find((s) => s.id === id);
  if (!skill) return;
  state.open = { type: 'skill', id };
  panel.hidden = false;

  const node = $('#tpl-chat').content.cloneNode(true);
  $('.avatar', node).textContent = avatarFor(skill);
  $('.chat-title', node).textContent = skill.id;
  $('.chat-meta', node).textContent = `${originLabel(skill)} · despacho de la skill`;
  $('.chat-desc p', node).textContent = skill.description || 'Sin descripción.';
  panelBody.replaceChildren(node);

  const form = $('.composer', panelBody);
  const textarea = $('textarea', form);
  form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(id, textarea); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(id, textarea); }
  });
  $('.reset', panelBody).addEventListener('click', () => resetConversation(id));
  $('.cancel', panelBody).addEventListener('click', () => api('POST', `/api/conversations/${encodeURIComponent(id)}/cancel`).catch((err) => toast(err.message, 'bad')));

  try {
    const conv = await api('GET', `/api/conversations/${encodeURIComponent(id)}`);
    state.conversations.set(id, conv.messages);
  } catch (err) {
    toast(err.message, 'bad');
  }
  if (state.open?.id === id) {
    renderMessages();
    renderChatState();
    textarea.focus();
  }
}

function messageHtml(m) {
  const who = m.role === 'director' ? state.director : m.role === 'skill' ? 'Skill' : 'Sistema';
  const proposal = m.proposalId && state.proposals.find((p) => p.id === m.proposalId);
  const pill = proposal ? `<span class="status-pill status-${proposal.status}">${proposal.status}</span>` : '';
  return `<div class="msg ${m.role}">${m.role === 'director' ? esc(m.text).replace(/\n/g, '<br>') : md(m.text)}
    <div class="msg-meta">${esc(who)} · ${time(m.ts)} ${pill}</div></div>`;
}

function renderMessages() {
  const box = $('.messages', panelBody);
  if (!box || state.open?.type !== 'skill') return;
  const messages = state.conversations.get(state.open.id) || [];
  const job = state.jobs.get(state.open.id);
  let html = messages.map(messageHtml).join('');
  if (job?.live) html += `<div class="msg skill live">${md(job.live)}</div>`;
  box.innerHTML = html || '<p class="empty-hint">Aún no habéis hablado. Dale una orden a esta skill: su respuesta llegará a tu bandeja como propuesta.</p>';
  box.scrollTop = box.scrollHeight;
}

function renderChatState() {
  if (state.open?.type !== 'skill' || !$('.working', panelBody)) return;
  const job = state.jobs.get(state.open.id);
  $('.working', panelBody).hidden = !job;
  if (job) $('.working-text', panelBody).textContent = job.tool ? `Trabajando… (usando ${job.tool})` : 'Trabajando…';
  $('.composer .primary', panelBody).disabled = Boolean(job);
}

async function sendMessage(id, textarea) {
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await api('POST', `/api/conversations/${encodeURIComponent(id)}/messages`, { text });
    textarea.value = '';
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function resetConversation(id) {
  if (!confirm('¿Empezar una conversación nueva con esta skill? La actual se borrará de este despacho.')) return;
  try {
    await api('POST', `/api/conversations/${encodeURIComponent(id)}/reset`);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// --- Bandeja del Director ------------------------------------------------------

function openInbox() {
  state.open = { type: 'inbox' };
  panel.hidden = false;
  const node = $('#tpl-inbox').content.cloneNode(true);
  panelBody.replaceChildren(node);

  panelBody.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => { state.inboxFilter = btn.dataset.filter; renderInbox(); });
  });
  $('.director-name', panelBody).addEventListener('click', renameDirector);
  $('.proposals', panelBody).addEventListener('click', onProposalClick);
  renderInbox();
}

function renderInbox() {
  const list = $('.proposals', panelBody);
  if (!list) return;
  $('.director-name', panelBody).textContent = state.director;
  panelBody.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.inboxFilter));

  const items = state.proposals
    .filter((p) => state.inboxFilter === 'todas' || p.status === state.inboxFilter)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Conserva lo que el Director esté escribiendo mientras llegan novedades.
  const drafts = new Map([...list.querySelectorAll('.proposal textarea')].map((t) => [t.closest('.proposal').dataset.id, t.value]));

  list.innerHTML = items.map(proposalHtml).join('')
    || `<p class="empty-hint">${state.inboxFilter === 'pendiente' ? 'No hay propuestas pendientes. Las respuestas de tus skills aparecerán aquí.' : 'Todavía no hay historial.'}</p>`;

  // El degradado y «Ver completa» solo tienen sentido si el texto no cabe.
  list.querySelectorAll('.proposal-body').forEach((body) => {
    if (body.scrollHeight <= body.clientHeight + 4) {
      body.classList.add('expanded');
      body.nextElementSibling.hidden = true;
    }
  });

  for (const [id, value] of drafts) {
    const t = list.querySelector(`.proposal[data-id="${id}"] textarea`);
    if (t) t.value = value;
  }
}

function proposalHtml(p) {
  const busy = state.jobs.has(p.skillId);
  const actions = p.status === 'pendiente'
    ? `<div class="proposal-actions">
        <textarea rows="2" placeholder="Indicaciones o motivo del rechazo (opcional para aprobar)"></textarea>
        <button class="btn-ok" data-act="aprobar" ${busy ? 'disabled' : ''}>✅ Aprobar</button>
        <button class="btn-bad" data-act="rechazar" ${busy ? 'disabled' : ''}>❌ Rechazar</button>
        <button class="btn-plain" data-act="responder">💬 Responder</button>
        <button class="btn-plain" data-act="archivar">🗄️ Archivar</button>
      </div>`
    : '';
  return `
    <article class="proposal" data-id="${p.id}">
      <div class="proposal-head">
        <span class="proposal-from">De: <button class="link" data-act="responder">${esc(p.skillId)}</button></span>
        <span class="status-pill status-${p.status}">${p.status}</span>
      </div>
      <div class="proposal-body">${md(p.text)}</div>
      <button class="link" data-act="expandir">Ver completa</button>
      ${p.feedback ? `<div class="proposal-feedback">Tu nota: ${esc(p.feedback)}</div>` : ''}
      <div class="msg-meta">${time(p.createdAt)}</div>
      ${actions}
    </article>`;
}

async function onProposalClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.proposal');
  const proposal = state.proposals.find((p) => p.id === card.dataset.id);
  const act = btn.dataset.act;

  if (act === 'expandir') {
    const body = $('.proposal-body', card);
    body.classList.toggle('expanded');
    btn.textContent = body.classList.contains('expanded') ? 'Ver menos' : 'Ver completa';
    return;
  }
  if (act === 'responder') return openSkill(proposal.skillId);

  const note = $('textarea', card)?.value.trim() || '';
  try {
    await api('POST', `/api/proposals/${proposal.id}/${act}`, { note });
    if (act === 'aprobar') toast(`Aprobada. «${proposal.skillId}» se pone manos a la obra.`, 'ok');
    if (act === 'rechazar') toast(`Rechazada. «${proposal.skillId}» preparará otra propuesta.`);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function renameDirector() {
  const name = prompt('¿Cómo quieres que te llamen en la oficina?', state.director);
  if (!name?.trim()) return;
  try {
    await api('PUT', '/api/director', { name });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// --- Tiempo real ---------------------------------------------------------------

function applySnapshot(data) {
  state.director = data.director;
  state.skills = data.skills;
  state.proposals = data.proposals;
  state.jobs = new Map(data.jobs.map((j) => [j.skillId, { tool: j.tool, live: '' }]));
  if (state.open?.type === 'skill' && !state.skills.some((s) => s.id === state.open.id)) closePanel();
}

const handlers = {
  snapshot(data) {
    applySnapshot(data);
    render();
    if (state.open?.type === 'skill') openSkill(state.open.id);
  },
  skills({ skills, added, removed }) {
    state.skills = skills;
    for (const id of added) {
      state.arrived.add(id);
      toast(`🎉 Nueva incorporación: «${id}» ya tiene despacho.`, 'ok');
    }
    for (const id of removed) toast(`👋 «${id}» ha dejado la oficina.`);
    if (state.open?.type === 'skill' && removed.includes(state.open.id)) closePanel();
    render();
  },
  director({ director }) {
    state.director = director;
    render();
  },
  message({ skillId, message }) {
    const msgs = state.conversations.get(skillId);
    if (msgs) msgs.push(message);
    if (state.open?.id === skillId) renderMessages();
  },
  'conversation:reset'({ skillId }) {
    state.conversations.set(skillId, []);
    if (state.open?.id === skillId) renderMessages();
  },
  proposal({ proposal }) {
    const idx = state.proposals.findIndex((p) => p.id === proposal.id);
    if (idx === -1) {
      state.proposals.push(proposal);
      if (proposal.status === 'pendiente') toast(`📥 Nueva propuesta de «${proposal.skillId}».`);
    } else {
      state.proposals[idx] = proposal;
    }
    render();
    if (state.open?.id === proposal.skillId) renderMessages();
  },
  'job:start'({ skillId }) {
    state.jobs.set(skillId, { tool: null, live: '' });
    render();
  },
  'job:delta'({ skillId, delta }) {
    const job = state.jobs.get(skillId);
    if (!job) return;
    job.live += delta;
    if (state.open?.id === skillId) renderMessages();
  },
  'job:tool'({ skillId, tool }) {
    const job = state.jobs.get(skillId);
    if (job) job.tool = tool;
    if (state.open?.id === skillId) renderChatState();
  },
  'job:end'({ skillId, isError }) {
    state.jobs.delete(skillId);
    if (isError) toast(`⚠️ «${skillId}» no pudo terminar el trabajo.`, 'bad');
    render();
    if (state.open?.id === skillId) renderMessages();
  },
};

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => { state.connected = true; renderTopbar(); });
  ws.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    handlers[data.type]?.(data);
  });
  ws.addEventListener('close', () => {
    state.connected = false;
    renderTopbar();
    setTimeout(connect, 2000);
  });
}

render();
connect();
