# Poolside Browser API

API local para consultar y enviar mensajes a Poolside mediante una pestaña de Chrome autenticada. La extensión ejecuta las solicitudes dentro de `chat.poolside.ai`; la API no lee ni exporta cookies.

La especificación completa está en [openapi.yaml](./openapi.yaml).
Este proyecto se distribuye bajo la [licencia MIT](./LICENSE).

## Seguridad

- El servidor escucha solo en `127.0.0.1`.
- Todas las rutas, salvo `GET /health`, exigen el encabezado `X-Poolside-API-Token`.
- La extensión y la API comparten el mismo token, guardado localmente y excluido de Git.
- CORS acepta por defecto solo solicitudes originadas desde `https://chat.poolside.ai`. Ajusta `POOLSIDE_ALLOWED_ORIGINS` únicamente si es imprescindible.
- Las solicitudes del content script llegan con el origen de la extensión. Si defines `POOLSIDE_ALLOWED_EXTENSION_IDS` con el id que muestra `chrome://extensions`, solo esa extensión pasa el filtro CORS; sin esa variable se acepta cualquier origen `chrome-extension://` con un id bien formado. El token sigue siendo obligatorio en ambos casos.
- La API no crea perfiles de Chrome ni persiste sesiones: si el puente no está disponible, solo intenta conectarse a un Chrome que ya exponga DevTools Protocol.
- **`.poolside-profile/` no lo genera esta API.** Es un perfil de Chrome de una versión anterior que puede haber quedado en tu copia de trabajo con cookies de sesión reales. Está excluido de Git, pero conviene borrarlo si no lo usas: `Remove-Item -Recurse -Force .poolside-profile`.
- Los errores inesperados se registran por consola y la API devuelve un mensaje genérico, para no exponer rutas locales ni detalles del entorno.

## Requisitos

Node.js 22 o superior.

## Instalación

```powershell
cd <directorio-clonado>\poolside-api
npm ci

$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$env:POOLSIDE_API_TOKEN = [Convert]::ToHexString($tokenBytes).ToLower()
$env:POOLSIDE_API_TOKEN

npm start
```

Guarda el token en un gestor de secretos local. No lo incluyas en comandos compartidos, archivos versionados ni capturas de pantalla.

## Configurar la extensión

1. Abre `chrome://extensions`.
2. Activa **Developer mode**.
3. Selecciona **Load unpacked** y elige `<directorio-clonado>\poolside-api\chrome-bridge`.
4. En la tarjeta de la extensión, abre **Extension options**.
5. Pega el valor de `POOLSIDE_API_TOKEN` y guarda.
6. Recarga la pestaña de Poolside.

## Uso

Define una variable de cabecera para los comandos locales:

```powershell
$headers = @{ "X-Poolside-API-Token" = $env:POOLSIDE_API_TOKEN }

Invoke-RestMethod http://127.0.0.1:3100/health
Invoke-RestMethod http://127.0.0.1:3100/chats -Headers $headers
Invoke-RestMethod http://127.0.0.1:3100/chats/<chatId> -Headers $headers

$chat = Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3100/chats `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"title":"Investigación independiente","model":"poolside/laguna-s-2.1"}'

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3100/message `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body (@{chatId=$chat.id;message="Responde únicamente OK";model="poolside/laguna-s-2.1";thinking=$true;webSearch=$false} | ConvertTo-Json)
```

Modelos admitidos:

- `poolside/laguna-s-2.1`
- `poolside/laguna-xs-2.1`

Los adjuntos aún no están implementados. La integración depende de las rutas internas de Poolside y puede requerir ajustes si cambian.

## Pruebas

```powershell
npm test
```

Cubren autenticación, política CORS, validación de entrada y el ciclo de vida de la cola del puente (entrega, error propagado y descarte de comandos caducados), además del perímetro de escritura de los subagentes. No requieren Chrome ni una cuenta de Poolside.

## Agente local con escritura acotada

El ejemplo `examples/local-file-agent.mjs` crea un chat limpio, solicita contenido a Poolside y escribe el resultado en un archivo local. Solo acepta rutas relativas dentro de la carpeta indicada y, de forma predeterminada, no reemplaza archivos existentes ni sigue enlaces simbólicos.

```powershell
$env:POOLSIDE_API_TOKEN = '<tu-token>'
node examples/local-file-agent.mjs `
  --workspace .\.agent-output `
  --file resumen.md `
  --prompt 'Escribe un resumen de tres puntos sobre pruebas de software.'
```

Usa `--overwrite` únicamente si quieres reemplazar un archivo existente. La carpeta predeterminada sugerida `.agent-output` está excluida de Git.

## Subagente para un proyecto acotado

`examples/delegated-workspace-agent.mjs` delega una tarea a Poolside con contexto explícito. Por defecto solo devuelve un plan JSON; no escribe nada. Revisa el plan y ejecútalo con `--apply` cuando estés conforme. Para reemplazar archivos existentes se requieren tanto `--apply` como `--overwrite`.

```powershell
node examples/delegated-workspace-agent.mjs `
  --workspace 'C:\ruta\a\mi-proyecto' `
  --context 'src\app.js,README.md' `
  --task 'Agrega una función de saludo documentada.'
```

El contexto y cada cambio propuesto se validan dentro de la carpeta del proyecto; no se permiten rutas absolutas, escapes con `..`, ni enlaces simbólicos.

Además hay un perímetro que el subagente nunca puede escribir, aunque la ruta esté dentro del proyecto o aparezca en `--allow`, porque equivale a ejecución de código en el siguiente comando de git, npm o CI: `.git/`, `.github/`, `.husky/`, `.vscode/`, `node_modules/`, `package.json`, `package-lock.json`, `.npmrc`, `.env`, `.gitignore` y `.gitattributes`.

`--allow` admite rutas exactas y patrones (`src/**`, `docs/*.md`, `src/`). El plan se escribe entero o no se escribe: si un cambio falla, se eliminan los archivos que esa ejecución había creado.

### Wrapper para KDD

Para un clon de [KDD](https://github.com/MauricioPerera/KDD), usa `kdd-coding-subagent.mjs`. Lee el Task Contract, suministra las reglas de `.agents/AGENTS.md` y limita los cambios exactamente a `touch_only`.

```powershell
node examples/kdd-coding-subagent.mjs `
  --kdd-root 'C:\ruta\a\KDD' `
  --contract 'knowledge\contracts\assemble-context.md'
```

El primer comando solo devuelve el plan. Después de revisarlo, añade `--apply`; para modificar un archivo existente, añade también `--overwrite`.
