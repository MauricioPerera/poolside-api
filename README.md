# Poolside Browser API

API local que automatiza Poolside mediante una sesión autenticada de Chrome.

La especificación completa está en [openapi.yaml](./openapi.yaml).

## Uso

```powershell
cd <directorio-clonado>\poolside-api
npm install
npm start
```

Se abrirá una ventana de Chrome con un perfil separado. Inicia sesión allí si es necesario.

Por defecto, el servicio intenta conectarse primero a Chrome mediante DevTools Protocol en `http://127.0.0.1:9222`. Si no está disponible, usa el perfil separado `.poolside-profile`.

## Puente para la sesión actual

La alternativa recomendada para conservar tu Chrome actual es cargar la extensión local:

1. Abre `chrome://extensions`.
2. Activa **Developer mode**.
3. Selecciona **Load unpacked**.
4. Elige la carpeta `<directorio-clonado>\poolside-api\chrome-bridge`.
5. Recarga la pestaña de Poolside.

La extensión solo ejecuta solicitudes dentro de `chat.poolside.ai` y se comunica con `127.0.0.1:3100`; no lee ni almacena cookies.

Para usar la sesión normal de Chrome, cierra todas sus ventanas y arráncalo una vez con depuración local habilitada:

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
```

No compartas ese puerto fuera de tu computadora. Si Chrome está instalado en otra ubicación, define `CHROME_PATH` antes de iniciar.

## Endpoints

La API pública expone `GET /health`, `GET /chats`, `GET /chats/:chatId` y `POST /message`.
Los endpoints `/bridge/*` son internos y los usa exclusivamente la extensión local.

```powershell
Invoke-RestMethod http://127.0.0.1:3100/health

Invoke-RestMethod http://127.0.0.1:3100/chats

Invoke-RestMethod http://127.0.0.1:3100/chats/zU2tyjHTTsi4FwaLiGCP6VvV

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3100/message `
  -ContentType 'application/json' `
  -Body '{"message":"Responde únicamente OK","model":"poolside/laguna-s-2.1","thinking":true,"webSearch":false}'
```

Esta integración depende de la interfaz visible de Poolside y puede requerir ajustes si cambia su HTML. No comparte credenciales: la sesión queda en `.poolside-profile`, que está excluida de Git.
