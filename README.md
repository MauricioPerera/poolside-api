# Poolside Browser API

API local para consultar y enviar mensajes a Poolside mediante una pestaña de Chrome autenticada. La extensión ejecuta las solicitudes dentro de `chat.poolside.ai`; la API no lee ni exporta cookies.

La especificación completa está en [openapi.yaml](./openapi.yaml).
Este proyecto se distribuye bajo la [licencia MIT](./LICENSE).

## Seguridad

- El servidor escucha solo en `127.0.0.1`.
- Todas las rutas, salvo `GET /health`, exigen el encabezado `X-Poolside-API-Token`.
- La extensión y la API comparten el mismo token, guardado localmente y excluido de Git.
- CORS acepta por defecto solo solicitudes originadas desde `https://chat.poolside.ai`. Ajusta `POOLSIDE_ALLOWED_ORIGINS` únicamente si es imprescindible.
- Si el puente de Chrome no está disponible, la API solo intenta conectarse a un Chrome que ya exponga DevTools Protocol; no crea perfiles ni persiste sesiones.

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

### Wrapper para KDD

Para un clon de [KDD](https://github.com/MauricioPerera/KDD), usa `kdd-coding-subagent.mjs`. Lee el Task Contract, suministra las reglas de `.agents/AGENTS.md` y limita los cambios exactamente a `touch_only`.

```powershell
node examples/kdd-coding-subagent.mjs `
  --kdd-root 'C:\ruta\a\KDD' `
  --contract 'knowledge\contracts\assemble-context.md'
```

El primer comando solo devuelve el plan. Después de revisarlo, añade `--apply`; para modificar un archivo existente, añade también `--overwrite`.
