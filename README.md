# 🏢 Oficina de Skills

Una oficina virtual donde **cada skill de Claude que tienes instalada ocupa su propio despacho** dentro de un edificio, y **tú eres el Director**. Desde la oficina puedes dar órdenes a cualquier skill, y todo lo que te respondan llega a tu bandeja como **propuesta** que puedes aprobar, rechazar o responder.

![Estado](https://img.shields.io/badge/estado-en%20desarrollo-f5b942) ![Node](https://img.shields.io/badge/node-%3E%3D20-4cc38a)

## ✨ Qué hace

| Función | Descripción |
|---|---|
| 🏗️ **Edificio vivo** | Cada skill es un despacho iluminado. Cuatro despachos por planta; las plantas crecen solas a medida que añades skills. |
| 🔄 **Auto-incorporación** | El servidor vigila las carpetas de skills de Claude Code. Al instalar una skill nueva aparece en el edificio al momento, con animación de bienvenida y aviso. Si la desinstalas, deja la oficina. |
| 💬 **Chat con cada skill** | Al pulsar un despacho se abre un chat. Tus mensajes se envían a Claude Code (`claude -p`) pidiéndole que use esa skill; la respuesta se ve escribirse en directo y la conversación se mantiene entre mensajes. |
| 👔 **Despacho de Dirección** | En el ático está tu despacho. Toda respuesta de una skill llega a tu bandeja como **propuesta pendiente**. |
| ✅ **Aprobar / ❌ Rechazar** | Aprobar le dice a la skill que proceda (con indicaciones opcionales). Rechazar le envía tu motivo y le pide una nueva propuesta. También puedes responder libremente o archivar. |
| 🚦 **Estado de cada despacho** | Luz azul parpadeante = trabajando · luz ámbar + globo = propuestas pendientes. |

## 📋 Requisitos

- **Node.js 20 o superior**
- **Claude Code** instalado y con sesión iniciada (el comando `claude` debe funcionar en tu terminal)
- Linux o macOS (en Windows funciona dentro de WSL)

## 🚀 Instalación y uso

```bash
git clone https://github.com/Eriiicc03/oficinaSkills.git
cd oficinaSkills
npm install
npm start
```

Abre **http://localhost:4321** en el navegador.

1. Pulsa sobre el nombre del Director (en la bandeja) para poner el tuyo.
2. Haz clic en el despacho de una skill y escríbele una orden (`Ctrl+Enter` para enviar).
3. Cuando termine, su respuesta aparecerá en **📥 Bandeja** como propuesta.
4. Apruébala, recházala con un motivo o respóndele.

Para desarrollo, `npm run dev` reinicia el servidor al cambiar el código. `npm test` lanza los tests.

## ⚙️ Configuración

Todo se ajusta con variables de entorno:

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PORT` | `4321` | Puerto del servidor web |
| `HOST` | `127.0.0.1` | Interfaz donde escucha. **Déjalo en local** (ver Seguridad) |
| `OFICINA_DIRECTOR` | `Director` | Nombre inicial del Director (luego se cambia desde la web) |
| `OFICINA_PERMISSION_MODE` | `acceptEdits` | Permisos de Claude: `default`, `acceptEdits`, `plan` o `bypassPermissions` |
| `OFICINA_WORKSPACE` | `./workspace` | Carpeta donde trabajan las skills y dejan sus archivos |
| `OFICINA_DATA_DIR` | `./data` | Dónde se guardan conversaciones y propuestas |
| `OFICINA_SKILL_DIRS` | — | Carpetas extra con skills, separadas por `:` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Carpeta de configuración de Claude Code |
| `CLAUDE_BIN` | `claude` | Ruta al ejecutable de Claude Code |

Ejemplo: `OFICINA_DIRECTOR="Eric" PORT=8080 npm start`

## 🔍 De dónde salen las skills

El servidor busca ficheros `SKILL.md` en:

- `~/.claude/skills/`: tus skills personales y las sincronizadas desde claude.ai
- `~/.claude/plugins/cache/` y `~/.claude/plugins/synced/`: skills de plugins instalados (aparecen como `plugin:skill`)
- Las carpetas de `OFICINA_SKILL_DIRS`

Del frontmatter de cada `SKILL.md` lee `name` y `description`. Para detectar cambios usa `fs.watch` (reacción inmediata) y, además, revisa las carpetas cada 15 segundos.

> Las carpetas de `OFICINA_SKILL_DIRS` solo hacen que la skill aparezca en la oficina. Para que Claude pueda *usarla* de verdad, tiene que estar instalada en Claude Code.

## 🧠 Cómo funciona

Consulta [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) para el detalle técnico. En resumen:

```
Navegador (public/)  ⇄  WebSocket + REST  ⇄  Servidor Node (server/)  →  claude -p (stream-json)
                                                   │
                                     fs.watch ~/.claude/skills, plugins
```

## 🔐 Seguridad

- El servidor **lanza Claude Code con tu cuenta**, así que solo escucha en `127.0.0.1`. No lo expongas a internet ni a tu red sin añadir autenticación.
- Con `acceptEdits`, las skills pueden crear y editar archivos en la carpeta `workspace/`. Las herramientas que necesitan permiso (por ejemplo, comandos de terminal) se deniegan, porque no hay nadie para aprobarlas. Con `bypassPermissions` lo pueden hacer todo: úsalo solo si sabes lo que haces.
- `data/` y `workspace/` están en `.gitignore` y no se suben al repositorio.

## 📁 Estructura

```
oficinaSkills/
├── server/
│   ├── index.js      # API REST, WebSocket y flujo de propuestas
│   ├── skills.js     # Detección y vigilancia de skills
│   ├── claude.js     # Puente con Claude Code (claude -p, stream-json)
│   ├── store.js      # Persistencia en data/state.json
│   └── config.js     # Variables de entorno
├── public/           # Interfaz: edificio, chats y bandeja (HTML/CSS/JS sin frameworks)
├── test/             # Tests (node --test)
└── docs/             # Documentación técnica y hoja de ruta
```

## 🗺️ Hoja de ruta

Consulta [docs/ROADMAP.md](docs/ROADMAP.md) para ver las ideas en marcha y las próximas.

## 📝 Registro de cambios

Consulta [CHANGELOG.md](CHANGELOG.md).
