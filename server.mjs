import http from "node:http";
import { timingSafeEqual } from "node:crypto";
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
const models = new Set(["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"]);

if (!apiToken || apiToken.length < 32) {
  throw new Error("Define POOLSIDE_API_TOKEN con al menos 32 caracteres antes de iniciar la API.");
}

let context;
let page;
let operation = Promise.resolve();
const bridgeQueue = [];
const bridgePending = new Map();
let lastBridgePollAt = 0;

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

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!allowedOrigins.has(origin)) throw new HttpError(403, "Origen no permitido.");
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
  return Date.now() - lastBridgePollAt < 5_000;
}

function enqueueBridge(command) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bridgePending.delete(id);
      reject(new HttpError(504, "La extensión de Chrome no respondió a tiempo."));
    }, 120_000);
    bridgePending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    bridgeQueue.push({ id, ...command });
  });
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
  if (payload.message.length > 100_000) throw new HttpError(413, "El mensaje supera el tamaño permitido.");
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

async function sendMessageDirect(payload) {
  const chats = await listChatsDirect();
  const currentUrl = (await browserPage()).url();
  const currentId = currentUrl.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1];
  const chatId = payload.chatId || currentId || chats[0]?.id;
  if (!chatId) throw new HttpError(409, "No hay una conversación disponible. Crea un chat en Poolside primero.");

  const state = await getChatDirect(chatId);
  const baseMessageId = state.messages?.at(-1)?.id || state.prefixLastMessageId;
  if (!baseMessageId) throw new HttpError(409, "No se pudo determinar el mensaje base de la conversación.");

  const generationId = crypto.randomUUID();
  const requestPayload = {
    chatId,
    model: payload.model || "poolside/laguna-s-2.1",
    inferenceMode: "platform",
    options: { webSearch: payload.webSearch !== false, thinking: payload.thinking !== false, slack: false, slackWrite: false },
    id: chatId,
    trigger: "submit-message",
    baseMessageId,
    message: { parts: [{ type: "text", text: payload.message }], id: crypto.randomUUID(), role: "user" },
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
    if (size > 100_000) throw new HttpError(413, "El cuerpo de la solicitud es demasiado grande.");
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
      const command = bridgeQueue.shift();
      if (!command) return json(res, 204, null, headers);
      return json(res, 200, command, headers);
    }

    if (req.method === "POST" && req.url === "/bridge/result") {
      const result = await body(req);
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

    const chatMatch = req.method === "GET" && req.url.match(/^\/chats\/([^/?#]+)$/);
    if (chatMatch) {
      const id = validateChatId(decodeURIComponent(chatMatch[1]));
      const chat = await enqueue(() => bridgeOrCdp({ type: "getChat", chatId: id }, () => getChatDirect(id)));
      return json(res, 200, chat, headers);
    }

    if (req.method === "POST" && req.url === "/message") {
      const payload = validateMessagePayload(await body(req));
      const result = await enqueue(() => bridgeOrCdp({ type: "sendMessage", payload }, () => sendMessageDirect(payload)));
      return json(res, 200, result, headers);
    }

    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Error interno.";
    json(res, status, { error: message }, headers);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Poolside API escuchando en http://127.0.0.1:${port}`);
});

process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
