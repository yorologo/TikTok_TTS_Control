# TikTok TTS Dashboard (Local) — Technical Report

Aplicación **local** en Node.js que se conecta al chat de **TikTok Live**, modera mensajes, administra una **cola de TTS**, y expone un **dashboard web local** para control y monitoreo. Pensada para **Windows 11**: servidor (Express + Socket.IO) + UI estática.

> **Alcance:** todo corre en tu PC. No hay almacenamiento remoto.

## Tabla de contenido

* [Características](#características)
* [Arquitectura](#arquitectura)
* [Estructura del proyecto](#estructura-del-proyecto)
* [Requisitos](#requisitos)
* [Ejecución local](#ejecución-local)
* [Configuración](#configuración)
* [Moderación](#moderación)
* [Cola TTS](#cola-tts)
* [Piper (motor TTS opcional)](#piper-motor-tts-opcional)
* [API HTTP](#api-http)
* [Socket.IO](#socketio)
* [UI (Dashboard)](#ui-dashboard)
* [Debug en VS Code](#debug-en-vs-code)
* [Notas y troubleshooting](#notas-y-troubleshooting)
* [Roadmap](#roadmap)

## Características

* Ingesta de chat de TikTok Live (conectar/desconectar bajo demanda)
* Pipeline de moderación:

  * badwords (exactos y por substring)
  * filtros anti-spam, URLs, menciones
  * allowlist de caracteres
* Strikes por usuario + **auto-ban** opcional
* Cola TTS con cooldown global y por usuario
* Ban/unban manual + edición de listas
* Dashboard local con Tailwind UI, dark mode y estado en vivo
* Inyección de mensajes de prueba y “skip” de cola
* Editor de settings en runtime (cooldowns, límites, auto-ban, voz/rate)
* **Motor TTS configurable:** `say` (default) o **`piper` (opcional)** con fallback automático a `say` si Piper falla

## Arquitectura

### Componentes principales

* **Backend:** `server.mjs` (Express + Socket.IO)
* **Frontend:** `public/index.html`, `public/app.js` (UI estática + Socket.IO client)
* **Persistencia local:** archivos JSON/TXT en `data/`

### Diagrama de componentes (UML / Mermaid)

```mermaid
flowchart LR
  UI[Browser UI<br/>public/index.html + app.js] <-- Socket.IO --> S[Node Server<br/>server.mjs]
  UI <-- HTTP (REST) --> S

  S --> M[Moderation Pipeline]
  S --> Q[TTS Queue Manager]
  S --> TTS["TTS Engine<br/>say OR piper"]
  S <--> FS[(data/ files)]

  TikTok[TikTok Live Chat] -->|events| S
```

## Estructura del proyecto

```text
/
├─ server.mjs
├─ public/
│  ├─ index.html
│  └─ app.js
└─ data/
   ├─ settings.json
   ├─ banned_users.json
   ├─ badwords_exact_es.txt
   └─ badwords_substring_es.txt
```

> Si usas Piper, se recomienda crear:

```text
data/piper/
  <modelo>.onnx
  <modelo>.onnx.json
```

## Requisitos

* Windows 10/11 (orientado a Windows 11)
* Node.js **18+** (probado con Node 25)
* Nombre de usuario de TikTok (para conectar a Live)
* Para Piper (opcional):

  * **Python 3.12 o 3.13 x64** (recomendado)
  * Paquete `piper-tts` instalado en un venv del proyecto
  * Modelo de voz Piper (`.onnx` + `.onnx.json`)

## Ejecución local

```bash
npm install
node server.mjs
```

Dashboard (por defecto): `http://127.0.0.1:8787`

> Si cambias `bindHost` a `0.0.0.0`, el dashboard quedará accesible desde tu red local (implica riesgo si no lo proteges).

## Configuración

### Archivo principal: `data/settings.json`

Ejemplo (con defaults + Piper):

```json
{
  "tiktokUsername": "TU_USUARIO_SIN_ARROBA",
  "bindHost": "127.0.0.1",
  "port": 8787,

  "ttsEnabled": true,
  "ttsEngine": "say",

  "globalCooldownMs": 9000,
  "perUserCooldownMs": 30000,
  "maxQueue": 6,
  "maxChars": 80,
  "maxWords": 14,

  "ttsVoice": "",
  "ttsRate": 1.0,

  "piper": {
    "pythonCmd": "",
    "modelPath": "",
    "lengthScale": 1.0,
    "volume": 1.0
  },

  "autoBan": {
    "enabled": true,
    "strikeThreshold": 2,
    "banMinutes": 30
  }
}
```

> Nota: los nombres exactos de campos de Piper (`pythonCmd`, `modelPath`, etc.) corresponden a la integración descrita (panel Opciones y guardado en `settings.json`).

### Campos (resumen)

* **tiktokUsername:** usuario sin `@`
* **bindHost / port:** binding del servidor local
* **ttsEnabled:** habilita/deshabilita salida de voz
* **ttsEngine:** `"say"` o `"piper"`
* **globalCooldownMs:** cooldown global entre lecturas
* **perUserCooldownMs:** cooldown por usuario
* **maxQueue:** tamaño máximo de cola
* **maxChars / maxWords:** límites del mensaje a encolar
* **ttsVoice / ttsRate:** (solo `say`) selección de voz y velocidad
* **piper.***: (solo `piper`) configuración de CLI/modelo
* **autoBan:** configuración de strikes y ban automático

> Recomendación: trata `data/` como “estado” de la app. Editar a mano es posible, pero idealmente se gestiona desde el dashboard.

## Moderación

### Objetivo

Evitar que contenido no deseado llegue a TTS (spam, enlaces, menciones, ofuscación de insultos, etc.) y aplicar strikes/bans.

### Reglas (resumen)

* **Bloqueo de URLs:** detecta `http`, `www` y TLDs comunes
* **Bloqueo de menciones:** patrones tipo `@usuario`
* **Spam:** repetición excesiva de caracteres o puntuación
* **Allowlist:** solo letras latinas, números, espacios y puntuación básica
* **Bad words:**

  * **Exact match** por token (palabra)
  * **Substring** sobre tokens unidos (anti-ofuscación)

### Diagrama de secuencia (UML / Mermaid)

```mermaid
sequenceDiagram
  autonumber
  participant TK as TikTok Live
  participant SV as Server (Express/Socket.IO)
  participant MOD as Moderation
  participant BAN as Strikes/Ban logic
  participant Q as Queue
  participant UI as Dashboard

  TK->>SV: chatMessage(user, text)
  SV->>MOD: validate(text)
  MOD-->>SV: verdict(allow/deny, reason)

  alt deny
    SV->>BAN: addStrike(user, reason)
    BAN-->>SV: banApplied? (optional)
    SV-->>UI: log / status update
  else allow
    SV->>Q: enqueue(user, text)
    Q-->>SV: enqueued(id) or rejected(maxQueue/cooldowns)
    SV-->>UI: queue/status updates
  end
```

## Cola TTS

### Comportamiento

* **Cap** por `maxQueue`
* Respeta:

  * `globalCooldownMs` (entre lecturas)
  * `perUserCooldownMs` (entre mensajes del mismo usuario)
* Motor TTS configurable:

  * `say` (por defecto)
  * `piper` (opcional)
* **Skip manual**: elimina un mensaje en cola por `id`

### Estado típico (diagrama de estados)

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Speaking: queue not empty & cooldown ok
  Speaking --> Cooldown: finished speaking
  Cooldown --> Idle: cooldown elapsed
  Idle --> Idle: queue empty
```

## Piper (motor TTS opcional)

Piper está integrado como motor alternativo. Se invoca mediante **Piper CLI** para generar un **WAV**, y luego se reproduce en Windows con **SoundPlayer**. Si Piper falla por cualquier razón (comando inexistente, modelo inválido, error de ejecución), el servidor hace **fallback automático a `say`** para no interrumpir la cola.

### Cambios principales (implementación)

* Motor TTS configurable + Piper CLI (WAV + SoundPlayer) en `server.mjs`
* Nuevos campos de Piper en el panel lateral **Opciones → TTS** (`index.html`)
* Lógica UI para mostrar/ocultar ajustes de Piper y guardar en runtime (`app.js`)
* Defaults persistidos en `data/settings.json`

### Instalación de Piper (Windows 11)

#### 1) Usar Python compatible (recomendado 3.12 o 3.13)

> Evita Python “bleeding edge” (ej. 3.14), ya que dependencias como `onnxruntime` pueden no tener wheels disponibles.

Crea y activa un venv en la carpeta del proyecto:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -V
```

#### 2) Instalar Piper

```powershell
python -m pip install --upgrade pip
python -m pip install piper-tts
```

Verifica:

```powershell
python -m piper --help
```

### Descargar un modelo de voz (.onnx + .onnx.json)

Crea carpeta recomendada:

```powershell
mkdir .\data\piper -Force | Out-Null
```

Coloca ambos archivos del modelo en `data/piper/`:

* `es_MX-claude-high.onnx`
* `es_MX-claude-high.onnx.json`

> Importante: **Piper requiere ambos** (`.onnx` y `.onnx.json`). Si falta el `.json`, fallará la síntesis.

### Probar Piper manualmente (recomendado)

Con el venv activo:

```powershell
"Hola, prueba de Piper." | python -m piper `
  -m ".\data\piper\es_MX-claude-high.onnx" `
  --output_file ".\data\piper\test.wav"

(New-Object System.Media.SoundPlayer ".\data\piper\test.wav").PlaySync()
```

Si escuchas el WAV, Piper está listo.

### Configurar Piper en el dashboard

1. Inicia el servidor:

```powershell
node server.mjs
```

2. Abre el dashboard y ve a **Opciones → TTS**:

* **Motor:** `Piper`
* **Modelo (.onnx):** ruta al `.onnx` (recomendado relativo)

  * Ejemplo: `.\data\piper\es_MX-claude-high.onnx`
* **Length scale:** controla la velocidad:

  * `1.0` normal
  * `> 1.0` más lento
  * `< 1.0` más rápido
* **Volumen:** `1.0` recomendado (ajusta si lo deseas)
* **Python cmd:** comando para ejecutar Piper

#### Python cmd (muy importante)

Para evitar problemas de entorno, se recomienda usar la ruta completa al Python del venv:

* Ejemplo:

  * `C:\...\TiktokTTS\.venv\Scripts\python.exe`

Alternativas (menos robustas):

* `python` (solo si el venv está activo cuando se ejecuta el server)
* `py -3.13` (si el launcher está disponible y funciona bien desde Node)

3. Guarda opciones. Esto persistirá en `data/settings.json`.

4. Prueba con un mensaje de prueba (UI o `/api/queue/test`).

### Diagrama de selección de motor (Mermaid)

```mermaid
flowchart TD
  Q[TTS Queue] --> SPEAK[Speak Next]
  SPEAK --> ENG{ttsEngine}
  ENG -->|say| SAY[say.speak]
  ENG -->|piper| PIP[Piper CLI: text -> WAV]
  PIP --> PLAY[SoundPlayer PlaySync]
  PIP -->|error| FALLBACK[Fallback to say]
  FALLBACK --> SAY
```

## API HTTP

Base: `http://127.0.0.1:8787`

> Convención recomendada: todas las rutas `/api/*` devuelven JSON.

### Status

* `GET /api/status`

  * `{ ttsEnabled, speaking, queueSize }`

### Queue

* `POST /api/queue/clear`
* `POST /api/queue/skip` body: `{ id }`
* `POST /api/queue/test` body: `{ uniqueId, nickname, text, count }`

  * Encola mensajes de prueba (`count` de **1..50**)

**Ejemplo (PowerShell):**

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/api/queue/test" `
  -ContentType "application/json" `
  -Body (@{
    uniqueId="test_user_1"
    nickname="Tester"
    text="Hola desde test"
    count=3
  } | ConvertTo-Json)
```

### Bans

* `GET /api/bans`
* `POST /api/ban` body: `{ uniqueId, minutes, reason }`
* `POST /api/unban` body: `{ uniqueId }`

### Lists

* `GET /api/lists`
* `POST /api/lists` body: `{ exact, sub }`

  * `exact`: contenido para `badwords_exact_es.txt`
  * `sub`: contenido para `badwords_substring_es.txt`

### TikTok

* `GET /api/tiktok/status`
* `POST /api/tiktok/connect`
* `POST /api/tiktok/disconnect`

### Settings

* `GET /api/settings`
* `POST /api/settings` (campos esperados)

  * `globalCooldownMs`, `perUserCooldownMs`, `maxQueue`, `maxChars`, `maxWords`
  * `ttsRate` (0.5..2.0), `ttsVoice`
  * `ttsEngine` (`say`/`piper`) y campos `piper.*` si aplica
  * `autoBanEnabled`, `autoBanStrikeThreshold`, `autoBanBanMinutes`

### TTS Voices

* `GET /api/tts/voices`

  * Usa `say.getInstalledVoices`
  * Fallback en Windows vía `System.Speech`

## Socket.IO

### Eventos emitidos hacia el cliente

* `status` — estado general (TTS on/off, speaking, etc.)
* `queue` — estado/elementos en cola
* `bansUpdated` — cambios en lista de bans
* `listsUpdated` — cambios en badwords
* `settings` — settings actuales
* `tiktokStatus` — estado de conexión a Live
* `logBulk` — lote de eventos recientes
* `log` — evento individual

> Recomendación: documenta el “shape” de cada payload si lo tienes estable. Al menos `queue` debe incluir `id` porque `/api/queue/skip` lo requiere.

## UI (Dashboard)

Controles principales:

* Toggle TTS
* Connect / Disconnect TikTok
* Clear queue
* Skip por mensaje (clic en texto u opción “Omitir”)
* Ban/unban manual
* Edición de listas (exact/sub)
* Inserción de mensajes de prueba (con repetición)
* Panel de opciones:

  * cooldowns, límites, auto-ban
  * motor TTS (`say`/`piper`)
  * voz/rate (`say`) o modelo/lengthScale/volumen/pythonCmd (Piper)

## Debug en VS Code

Archivo: `.vscode/launch.json`

* **Server: Node** → ejecuta solo backend
* **App: Server + Client** → backend + Chrome

## Notas y troubleshooting

### No hay audio / no habla

* Verifica que **`ttsEnabled`** esté `true`
* Si estás en **`say`**:

  * Revisa voces instaladas (SAPI) y lista en `/api/tts/voices`
  * Si `ttsVoice` está vacío, usa la voz por defecto del sistema
* Si estás en **`piper`**:

  * Verifica `pythonCmd` (ideal: ruta completa al python del venv)
  * Verifica `modelPath` y que exista también el `.onnx.json`
  * Prueba Piper manualmente (sección “Probar Piper manualmente”)

### El puerto está ocupado

* Cambia `port` en `settings.json` o libera `127.0.0.1:8787`

### No conecta a TikTok Live

* Confirma `tiktokUsername` sin `@`
* Revisa que el live esté activo y que tu red no bloquee la conexión
* Observa `tiktokStatus` y logs en el dashboard

### Seguridad

* Por defecto usa `127.0.0.1` (solo local).
* Si expones `bindHost=0.0.0.0`, considera:

  * firewall
  * autenticación (si algún día la agregas)
  * evitar usarlo en redes públicas

## Roadmap

* Perfiles/presets de settings
* Allowlist de usuarios (mods)
* Toggle de filtrado de emojis
* Export/import de configuración
