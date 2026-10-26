// Configuración centralizada. Todo se puede ajustar con variables de entorno.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = Number(process.env.PORT || 4321);
// Solo escucha en local: el servidor lanza Claude con tu cuenta.
export const HOST = process.env.HOST || '127.0.0.1';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Carpetas adicionales con skills, separadas por ":".
export const EXTRA_SKILL_DIRS = (process.env.OFICINA_SKILL_DIRS || '')
  .split(':')
  .map((d) => d.trim())
  .filter(Boolean);

// Modo de permisos con el que trabajan las skills (default, acceptEdits,
// bypassPermissions, plan). En modo no interactivo las herramientas que
// requieran permiso y no estén permitidas se deniegan automáticamente.
export const PERMISSION_MODE = process.env.OFICINA_PERMISSION_MODE || 'acceptEdits';

export const DATA_DIR = process.env.OFICINA_DATA_DIR || path.join(ROOT_DIR, 'data');
// Carpeta de trabajo donde las skills crean sus archivos.
export const WORKSPACE_DIR = process.env.OFICINA_WORKSPACE || path.join(ROOT_DIR, 'workspace');

export const DEFAULT_DIRECTOR = process.env.OFICINA_DIRECTOR || 'Director';
