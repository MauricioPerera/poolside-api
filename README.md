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
