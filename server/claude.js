// Puente con Claude Code: ejecuta `claude -p` en modo stream-json y traduce su
// salida en eventos sencillos (texto parcial, uso de herramientas, resultado).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CLAUDE_BIN, PERMISSION_MODE, WORKSPACE_DIR } from './config.js';

export function systemPromptFor(skill, director) {
  return [
    'Trabajas dentro de la «Oficina de Skills», una oficina virtual.',
    `Ocupas el despacho de la skill «${skill.id}».`,
    `Quien te escribe es ${director}, el Director de la oficina.`,
    'Todo lo que respondas llega a su bandeja como una PROPUESTA que puede aprobar, rechazar con comentarios o responder.',
    'Responde en el idioma del Director, con claridad, y termina indicando qué decisión necesitas de él.',
  ].join(' ');
}

export function firstPromptFor(skill, text) {
  return `Usa la skill «${skill.id}» para atender esta petición del Director:\n\n${text}`;
}

/**
 * Lanza una ejecución de Claude.
 * @returns {{ done: Promise<{text: string, sessionId: string|null, isError: boolean}>, cancel: () => void }}
 */
export function runClaude({ prompt, sessionId, systemPrompt, onDelta, onTool }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', PERMISSION_MODE,
    '--append-system-prompt', systemPrompt,
  ];
  if (sessionId) args.push('--resume', sessionId);

  // Si el servidor se arranca desde una sesión de Claude Code, esta variable
  // haría creer al proceso hijo que está anidado.
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const child = spawn(CLAUDE_BIN, args, { cwd: WORKSPACE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const done = new Promise((resolve) => {
    let finalText = null;
    let streamedText = '';
    let newSessionId = sessionId || null;
    let isError = false;
    let stderr = '';

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch { return; }
      if (evt.session_id) newSessionId = evt.session_id;

      if (evt.type === 'stream_event') {
        const e = evt.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          streamedText += e.delta.text;
          onDelta?.(e.delta.text);
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          onTool?.(e.content_block.name);
        } else if (e?.type === 'message_start' && streamedText && !streamedText.endsWith('\n\n')) {
          // Separa los turnos de texto entre llamadas a herramientas.
          streamedText += '\n\n';
          onDelta?.('\n\n');
        }
      } else if (evt.type === 'result') {
        finalText = typeof evt.result === 'string' ? evt.result : null;
        isError = Boolean(evt.is_error);
      }
    });

    child.on('error', (err) => {
      resolve({ text: `No se pudo lanzar Claude (${CLAUDE_BIN}): ${err.message}`, sessionId: newSessionId, isError: true });
    });

    child.on('close', (code) => {
      let text = finalText ?? streamedText.trim();
      if (code !== 0 && !text) {
        isError = true;
        text = stderr.trim() || `Claude terminó con el código ${code}.`;
      }
      resolve({ text, sessionId: newSessionId, isError });
    });
  });

  return { done, cancel: () => child.kill('SIGTERM') };
}
