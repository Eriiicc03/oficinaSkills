# Arquitectura

## Visión general

La aplicación tiene dos piezas:

1. **Servidor Node.js** (`server/`), con Express para la API y los archivos estáticos y `ws` para el tiempo real.
2. **Cliente web** (`public/`), en HTML, CSS y JavaScript sin frameworks ni paso de compilación.

```
┌─────────────── Navegador ───────────────┐
│ Edificio · Chat de skill · Bandeja       │
└──────┬─────────────────────▲────────────┘
  REST │ (órdenes, decisiones)│ WebSocket /ws (eventos)
┌──────▼─────────────────────┴────────────┐
│ server/index.js                          │
│  ├─ SkillRegistry (skills.js) ◄── fs.watch + sondeo 15 s
│  ├─ Store (store.js) ──► data/state.json │
│  └─ runClaude (claude.js) ──► claude -p --output-format stream-json
└──────────────────────────────────────────┘
```

## Detección de skills (`server/skills.js`)

- Recorre de forma recursiva (hasta 8 niveles) las carpetas raíz buscando `SKILL.md`, y sigue enlaces simbólicos.
- Lee el frontmatter YAML con un parser mínimo propio (claves simples, comillas, bloques `>` y `|`).
- **Identificador**: `name` de la skill o, si pertenece a un plugin, `plugin:name`. El nombre del plugin sale del `.claude-plugin/plugin.json` más cercano.
- **Origen**: `personal`, `claude.ai` (la ruta contiene `/synced/`), `plugin` o `extra`.
- Si una skill aparece en varias rutas, gana la de fecha de modificación más reciente.
- Tras cada escaneo compara con el estado anterior y emite `change` con `{added, removed, changed}`.
- `plugins/marketplaces` se ignora porque es el catálogo, no lo instalado.

## Conversaciones con Claude (`server/claude.js`)

Cada mensaje lanza:

```
claude -p "<mensaje>" --output-format stream-json --verbose --include-partial-messages \
       --permission-mode <modo> --append-system-prompt "<contexto de oficina>" [--resume <sessionId>]
```

- El **primer mensaje** de una conversación se envuelve con «Usa la skill «X» para atender esta petición del Director».
- El **prompt de sistema añadido** explica a Claude que está en la oficina, que habla con el Director y que su respuesta será una propuesta.
- Se guarda el `session_id` y los siguientes mensajes usan `--resume`, así la skill recuerda la conversación.
- Los eventos `content_block_delta` se reenvían al navegador como `job:delta` (texto en directo), y los `tool_use` como `job:tool`.
- Si una ejecución falla, se olvida la sesión para que la siguiente empiece limpia.
- Todo se ejecuta con `cwd = workspace/`.

## Flujo de propuestas (`server/index.js`)

```
Director escribe ──► mensaje 'director' ──► claude -p ──► mensaje 'skill' + PROPUESTA (pendiente)
                                                             │
           ┌─────────────────────────────────────────────────┼──────────────┐
      Aprobar (nota opcional)                     Rechazar (motivo)     Archivar
           │                                                 │              │
  "✅ El Director APRUEBA…"                    "❌ El Director RECHAZA…"   sin mensaje
  → la skill continúa y genera                 → la skill prepara otra
    una nueva propuesta                          propuesta
```

Estados de una propuesta: `pendiente`, `aprobada`, `rechazada`, `respondida` (el Director escribió directamente a la skill) y `archivada`.

Cada skill solo puede tener un trabajo en curso a la vez; si ya está trabajando, la API responde `409`.

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/state` | Director, skills, propuestas y trabajos en curso |
| GET | `/api/skills` | Lista de skills detectadas |
| PUT | `/api/director` | `{name}`: cambia el nombre del Director |
| GET | `/api/conversations/:skillId` | Historial con una skill |
| POST | `/api/conversations/:skillId/messages` | `{text}`: envía una orden (202) |
| POST | `/api/conversations/:skillId/cancel` | Cancela el trabajo en curso |
| POST | `/api/conversations/:skillId/reset` | Empieza conversación nueva |
| POST | `/api/proposals/:id/aprobar` | `{note?}` |
| POST | `/api/proposals/:id/rechazar` | `{note}` (obligatorio) |
| POST | `/api/proposals/:id/archivar` | — |

## Eventos WebSocket (`/ws`)

| Tipo | Contenido |
|---|---|
| `snapshot` | Estado completo, enviado al conectar |
| `skills` | `{skills, added, removed}` |
| `director` | `{director}` |
| `message` | `{skillId, message}` |
| `conversation:reset` | `{skillId}` |
| `proposal` | `{proposal}` (nueva o actualizada) |
| `job:start` / `job:end` | `{skillId}` / `{skillId, isError}` |
| `job:delta` | `{skillId, delta}`: texto parcial |
| `job:tool` | `{skillId, tool}`: herramienta en uso |

## Persistencia (`server/store.js`)

Un único fichero `data/state.json` con escritura atómica (fichero temporal + `rename`) y guardado agrupado cada 250 ms:

```json
{
  "director": "Eric",
  "conversations": { "pdf": { "sessionId": "…", "messages": [ … ] } },
  "proposals": [ { "id": "…", "skillId": "pdf", "text": "…", "status": "pendiente", … } ]
}
```
