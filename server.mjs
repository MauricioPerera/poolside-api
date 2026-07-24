import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const port = Number(process.env.PORT || 3100);
const appUrl = process.env.POOLSIDE_URL || "https://chat.poolside.ai/";
const cdpUrl = process.env.POOLSIDE_CDP_URL || "http://127.0.0.1:9222";
const apiToken = process.env.POOLSIDE_API_TOKEN;
const allowedOrigins = new Set(
  (process.env.POOLSIDE_ALLOWED_ORIGINS || "https://chat.poolside.ai")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
// Si se declara, solo estas extensiones pueden usar CORS contra la API.
const allowedExtensionIds = new Set(
  (process.env.POOLSIDE_ALLOWED_EXTENSION_IDS || "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
);
const models = new Set(["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"]);
const maxBodyBytes = 200_000;
const maxMessageLength = 100_000;

if (!apiToken || apiToken.length < 32) {
  throw new Error("Define POOLSIDE_API_TOKEN con al menos 32 caracteres antes de iniciar la API.");
}

let context;
let page;
let operation = Promise.resolve();
const bridgeQueue = [];
const bridgePending = new Map();
let lastBridgePollAt = 0;
const bridgeConnectionWindowMs = 60_000;
// El puente sondea cada 750 ms: si no recoge el comando en unos segundos es que
// la pestaña ya no está viva, y conviene fallar rápido en lugar de bloquear la
// cola de peticiones durante el timeout largo de ejecución.
const bridgeDeliveryTimeoutMs = Number(process.env.POOLSIDE_BRIDGE_DELIVERY_TIMEOUT_MS || 10_000);
const bridgeResultTimeoutMs = Number(process.env.POOLSIDE_BRIDGE_RESULT_TIMEOUT_MS || 120_000);
const bridgeMaxQueue = 32;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function extensionOriginAllowed(origin) {
  // Las solicitudes del content script llegan con el origen de la extensión,
  // no con el de la página de Poolside. El token sigue siendo obligatorio.
  const id = origin.slice("chrome-extension://".length).toLowerCase();
  if (!/^[a-p]{32}$/.test(id)) return false;
  return allowedExtensionIds.size === 0 || allowedExtensionIds.has(id);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const isChromeExtension = origin.startsWith("chrome-extension://") && extensionOriginAllowed(origin);
  if (!allowedOrigins.has(origin) && !isChromeExtension) {
    throw new HttpError(403, "Origen no permitido.");
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-poolside-api-token",
    vary: "Origin"
  };
}

function tokenMatches(value) {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(apiToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireToken(req) {
  if (!tokenMatches(req.headers["x-poolside-api-token"])) {
    throw new HttpError(401, "Token de API inválido o ausente.");
  }
}

function bridgeIsConnected() {
  // Chrome puede limitar los temporizadores de una pestaña que está en segundo
  // plano. Un minuto evita falsos desconectados sin cambiar la autenticación.
  return Date.now() - lastBridgePollAt < bridgeConnectionWindowMs;
}

function dropFromBridgeQueue(id) {
  const index = bridgeQueue.findIndex((item) => item.id === id);
  if (index !== -1) bridgeQueue.splice(index, 1);
}

function enqueueBridge(command) {
  if (bridgeQueue.length >= bridgeMaxQueue) {
    throw new HttpError(503, "La cola del puente está saturada; reintenta más tarde.");
  }
  const id = randomUUID();
  bridgeQueue.push({ id, ...command });
  return new Promise((resolve, reject) => {
    // Al resolver, rechazar o expirar hay que sacar el comando de la cola: si se
    // queda, un poll posterior lo entrega y la extensión ejecuta dos veces un
    // envío que la API ya dio por perdido.
    const settle = (finish) => (value) => {
      clearTimeout(deliveryTimer);
      clearTimeout(resultTimer);
      bridgePending.delete(id);
      dropFromBridgeQueue(id);
      finish(value);
    };
    const pending = { delivered: false, resolve: settle(resolve), reject: settle(reject) };
    const deliveryTimer = setTimeout(() => {
      if (!pending.delivered) pending.reject(new HttpError(504, "La extensión de Chrome no recogió el comando."));
    }, bridgeDeliveryTimeoutMs);
    const resultTimer = setTimeout(() => {
      pending.reject(new HttpError(504, "La extensión de Chrome no respondió a tiempo."));
    }, bridgeResultTimeoutMs);
    bridgePending.set(id, pending);
  });
}

function nextBridgeCommand() {
  while (bridgeQueue.length) {
    const command = bridgeQueue.shift();
    const pending = bridgePending.get(command.id);
    if (!pending) continue;
    pending.delivered = true;
    return command;
  }
  return null;
}

async function bridgeOrCdp(command, fallback) {
  return bridgeIsConnected() ? enqueueBridge(command) : fallback();
}

async function browserPage() {
  if (!context) {
    try {
      context = await chromium.connectOverCDP(cdpUrl);
    } catch {
      throw new HttpError(503, "El puente de Chrome no está conectado y Chrome DevTools Protocol no está disponible.");
    }
  }

  page ||= context.pages().find((candidate) => candidate.url().startsWith("https://chat.poolside.ai/"));
  if (!page) throw new HttpError(503, "No hay una pestaña autenticada de Poolside disponible.");
  return page;
}

async function poolsideRequest(pathname, method = "GET", requestBody) {
  const currentPage = await browserPage();
  return currentPage.evaluate(async ({ pathname: requestPath, method: requestMethod, requestBody: bodyValue }) => {
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: bodyValue === undefined ? undefined : { "content-type": "application/json" },
      body: bodyValue === undefined ? undefined : JSON.stringify(bodyValue)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data, text };
  }, { pathname, method, requestBody });
}

async function listChatsDirect() {
  const result = await poolsideRequest("/api/chats?limit=100");
  if (!result.ok) throw new HttpError(502, `Poolside rechazó el historial (${result.status}).`);
  return (result.data?.recents || []).map((chat) => ({
    id: chat.id,
    title: chat.title || "Sin título",
    updatedAt: chat.updatedAt,
    isGenerating: Boolean(chat.isGenerating),
    url: `${appUrl.replace(/\/$/, "")}/c/${chat.id}`
  }));
}

async function getChatDirect(id) {
  const result = await poolsideRequest(`/api/chat/${id}/state?tail=100`);
  if (!result.ok) throw new HttpError(502, `Poolside rechazó la conversación (${result.status}).`);
  return { id, url: `${appUrl.replace(/\/$/, "")}/c/${id}`, ...result.data };
}

async function createChatDirect(payload) {
  const result = await poolsideRequest("/api/chats", "POST", {
    title: payload.title,
    model: payload.model || "poolside/laguna-s-2.1",
    inferenceMode: "platform",
    incognito: false
  });
  if (!result.ok) throw new HttpError(502, `Poolside no pudo crear la conversación (${result.status}).`);
  const id = result.data?.id || result.data?.chat?.id;
  if (!id) throw new HttpError(502, "Poolside creó una conversación sin devolver su id.");
  return { id, title: result.data?.title || payload.title, url: `${appUrl.replace(/\/$/, "")}/c/${id}` };
}

function validateChatId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, "El id de conversación no es válido.");
  }
  return value;
}

function validateMessagePayload(payload) {
  if (typeof payload.message !== "string" || !payload.message.trim()) {
    throw new HttpError(400, "El campo message es obligatorio y debe ser texto.");
  }
  if (payload.message.length > maxMessageLength) throw new HttpError(413, "El mensaje supera el tamaño permitido.");
  if (payload.chatId !== undefined) validateChatId(payload.chatId);
  if (payload.model !== undefined && !models.has(payload.model)) {
    throw new HttpError(400, "El modelo solicitado no está permitido.");
  }
  for (const option of ["thinking", "webSearch"]) {
    if (payload[option] !== undefined && typeof payload[option] !== "boolean") {
      throw new HttpError(400, `${option} debe ser booleano.`);
    }
  }
  if (payload.attachments !== undefined) {
    throw new HttpError(400, "Los adjuntos aún no están implementados.");
  }
  return { ...payload, message: payload.message.trim() };
}

function validateCreateChatPayload(payload) {
  if (typeof payload.title !== "string" || !payload.title.trim()) {
    throw new HttpError(400, "El campo title es obligatorio y debe ser texto.");
  }
  if (payload.title.length > 1_000) throw new HttpError(413, "El título supera el tamaño permitido.");
  if (payload.model !== undefined && !models.has(payload.model)) {
    throw new HttpError(400, "El modelo solicitado no está permitido.");
  }
  return { ...payload, title: payload.title.trim() };
}

async function sendMessageDirect(payload) {
  const chats = await listChatsDirect();
  const currentUrl = (await browserPage()).url();
  const currentId = currentUrl.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1];
  const chatId = payload.chatId || currentId || chats[0]?.id;
  if (!chatId) throw new HttpError(409, "No hay una conversación disponible. Crea un chat en Poolside primero.");

  // Solo hace falta el último mensaje para encadenar; pedir la cola entera
  // duplicaría el trabajo que ya hace la extensión con tail=1.
  const stateResult = await poolsideRequest(`/api/chat/${chatId}/state?tail=1`);
  if (!stateResult.ok) throw new HttpError(502, `Poolside rechazó la conversación (${stateResult.status}).`);
  const state = stateResult.data || {};
  const baseMessageId = state.messages?.at(-1)?.id || state.prefixLastMessageId;

  const generationId = randomUUID();
  const messageId = randomUUID();
  const requestPayload = {
    chatId,
    model: payload.model || "poolside/laguna-s-2.1",
    inferenceMode: "platform",
    options: { webSearch: payload.webSearch !== false, thinking: payload.thinking !== false, slack: false, slackWrite: false },
    id: chatId,
    trigger: "submit-message",
    messageId,
    baseMessageId: baseMessageId || null,
    message: { messageId, parts: [{ type: "text", text: payload.message }], id: messageId, role: "user" },
    generationId
  };

  const posted = await poolsideRequest("/api/chat", "POST", requestPayload);
  if (!posted.ok) throw new HttpError(502, `Poolside rechazó el mensaje (${posted.status}).`);

  const stream = await (await browserPage()).evaluate(async ({ chatId: id, generationId: generation }) => {
    const response = await fetch(`/api/chat/${id}/stream?generationId=${encodeURIComponent(generation)}`, { headers: { accept: "text/event-stream" } });
    if (!response.ok || !response.body) return { ok: false, status: response.status };
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
    return { ok: true, status: response.status };
  }, { chatId, generationId });
  if (!stream.ok) throw new HttpError(502, `No se pudo leer el stream de respuesta (${stream.status}).`);

  const finalState = await getChatDirect(chatId);
  const assistant = finalState.messages?.filter((item) => item.role === "assistant").at(-1);
  const response = assistant?.parts?.find((part) => part.type === "text")?.text;
  if (!response) throw new HttpError(502, "Poolside terminó el stream sin devolver texto.");
  return { chatId, model: requestPayload.model, options: requestPayload.options, response };
}

async function createChatWithBridge(payload) {
  const before = await enqueueBridge({ type: "listChats" });
  const result = await enqueueBridge({ type: "createChat", payload });
  const id = result?.id || result?.chat?.id;
  if (id) return { id, title: result.title || payload.title, url: `${appUrl.replace(/\/$/, "")}/c/${id}` };

  // Chrome puede omitir el valor de executeScript aunque la creación haya
  // terminado. Recuperamos el chat nuevo comparando el historial del puente.
  const existingIds = new Set(before.map((chat) => chat.id));
  const after = await enqueueBridge({ type: "listChats" });
  const created = after.find((chat) => !existingIds.has(chat.id)) || after.find((chat) => chat.title === payload.title);
  if (!created) throw new HttpError(502, "La extensión no devolvió el id de la conversación creada.");
  return created;
}

async function sendMessageWithBridge(payload) {
  const chats = await enqueueBridge({ type: "listChats" });
  const chatId = payload.chatId || chats[0]?.id;
  if (!chatId) throw new HttpError(409, "No hay una conversación disponible. Crea un chat en Poolside primero.");

  const bridgePayload = { ...payload, chatId };
  const result = await enqueueBridge({ type: "sendMessage", payload: bridgePayload });
  if (result && typeof result.response === "string") return result;

  // Algunas versiones de Chrome no devuelven el valor de executeScript en el
  // mundo principal. El envío ya terminó; recuperamos el estado final mediante
  // el mismo puente para conservar una respuesta útil para el cliente de API.
  const state = await enqueueBridge({ type: "getChat", chatId });
  const assistant = state.messages?.filter((item) => item.role === "assistant").at(-1);
  const response = assistant?.parts?.find((part) => part.type === "text")?.text;
  if (!response) throw new HttpError(502, "Poolside terminó el mensaje sin devolver texto.");
  return {
    chatId,
    model: payload.model || "poolside/laguna-s-2.1",
    options: { webSearch: payload.webSearch !== false, thinking: payload.thinking !== false },
    response
  };
}

function enqueue(task) {
  const next = operation.then(task, task);
  operation = next.catch(() => {});
  return next;
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    // Holgado respecto a maxMessageLength para que el límite del mensaje sea
    // alcanzable incluso con el escapado de JSON.
    if (size > maxBodyBytes) throw new HttpError(413, "El cuerpo de la solicitud es demasiado grande.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "El cuerpo debe ser JSON válido."); }
}

const server = http.createServer(async (req, res) => {
  let headers = {};
  try {
    headers = corsHeaders(req);
    if (req.method === "OPTIONS") return json(res, 204, null, headers);

    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "poolside-browser-api", port, bridge: bridgeIsConnected() }, headers);
    }

    requireToken(req);

    if (req.method === "GET" && req.url === "/bridge/next") {
      lastBridgePollAt = Date.now();
      const command = nextBridgeCommand();
      if (!command) return json(res, 204, null, headers);
      return json(res, 200, command, headers);
    }

    if (req.method === "POST" && req.url === "/bridge/result") {
      const result = await body(req);
      if (typeof result.id !== "string") throw new HttpError(400, "El resultado debe incluir el id del comando.");
      const pending = bridgePending.get(result.id);
      if (!pending) throw new HttpError(404, "Comando desconocido o expirado.");
      bridgePending.delete(result.id);
      if (result.ok) pending.resolve(result.result);
      else pending.reject(new HttpError(502, result.error || "La extensión no pudo completar el comando."));
      return json(res, 202, { accepted: true }, headers);
    }

    if (req.method === "GET" && req.url === "/chats") {
      const chats = await enqueue(() => bridgeOrCdp({ type: "listChats" }, listChatsDirect));
      return json(res, 200, { chats }, headers);
    }

    if (req.method === "POST" && req.url === "/chats") {
      const payload = validateCreateChatPayload(await body(req));
      const chat = await enqueue(() => bridgeOrCdp({ type: "createChat", payload }, () => createChatDirect(payload)));
      return json(res, 201, chat, headers);
    }

    const chatMatch = req.method === "GET" && req.url.match(/^\/chats\/([^/?#]+)$/);
    if (chatMatch) {
      const id = validateChatId(decodeURIComponent(chatMatch[1]));
      const chat = await enqueue(() => bridgeOrCdp({ type: "getChat", chatId: id }, () => getChatDirect(id)));
      return json(res, 200, chat, headers);
    }

    if (req.method === "POST" && req.url === "/message") {
      const payload = validateMessagePayload(await body(req));
      const result = await enqueue(() => bridgeIsConnected() ? sendMessageWithBridge(payload) : sendMessageDirect(payload));
      return json(res, 200, result, headers);
    }

    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message }, headers);
      return;
    }
    // Los errores inesperados (Playwright, CDP) llevan rutas locales y detalles
    // del entorno: se registran, no se devuelven.
    console.error("Error interno:", error);
    json(res, 500, { error: "Error interno." }, headers);
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Poolside API escuchando en http://127.0.0.1:${port}`);
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}

export { server, validateChatId, validateCreateChatPayload, validateMessagePayload };
