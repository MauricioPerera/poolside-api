import http from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3100);
const appUrl = process.env.POOLSIDE_URL || "https://chat.poolside.ai/";
const profileDir = path.join(rootDir, ".poolside-profile");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const cdpUrl = process.env.POOLSIDE_CDP_URL || "http://127.0.0.1:9222";

let context;
let page;
let connectedViaCdp = false;
let operation = Promise.resolve();
const bridgeQueue = [];
const bridgePending = new Map();
let lastBridgePollAt = 0;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

function bridgeIsConnected() {
  return Date.now() - lastBridgePollAt < 5_000;
}

function enqueueBridge(command) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bridgePending.delete(id);
      reject(new Error("La extensión de Chrome no respondió a tiempo."));
    }, 120_000);
    bridgePending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    bridgeQueue.push({ id, ...command });
  });
}

async function bridgeOrFallback(command, fallback) {
  if (bridgeIsConnected()) return enqueueBridge(command);
  return fallback();
}

async function browserPage() {
  if (!context) {
    try {
      context = await chromium.connectOverCDP(cdpUrl);
      connectedViaCdp = true;
      console.log(`Conectado al Chrome existente mediante ${cdpUrl}`);
    } catch {
      await mkdir(profileDir, { recursive: true });
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: chromePath,
        headless: false,
        viewport: { width: 1440, height: 1000 }
      });
      console.log("Chrome CDP no disponible; usando perfil separado.");
    }
  }

  page ||= context.pages().find((candidate) => candidate.url().startsWith("https://chat.poolside.ai/"))
    || context.pages()[0]
    || await context.newPage();
  if (!page.url().startsWith("https://chat.poolside.ai/")) {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  }
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
  if (!result.ok) throw new Error(`Poolside rechazó el historial (${result.status}). Inicia sesión en Chrome.`);
  return (result.data?.recents || []).map((chat) => ({
    id: chat.id,
    title: chat.title || "Sin título",
    updatedAt: chat.updatedAt,
    isGenerating: Boolean(chat.isGenerating),
    url: `${appUrl.replace(/\/$/, "")}/c/${chat.id}`
  }));
}

async function getChatDirect(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("El id de conversación no es válido.");
  const result = await poolsideRequest(`/api/chat/${id}/state?tail=100`);
  if (!result.ok) throw new Error(`Poolside rechazó la conversación (${result.status}).`);
  return { id, url: `${appUrl.replace(/\/$/, "")}/c/${id}`, ...result.data };
}

async function sendMessageDirect(payload) {
  const chats = await listChatsDirect();
  const currentUrl = (await browserPage()).url();
  const currentId = currentUrl.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1];
  const chatId = payload.chatId || currentId || chats[0]?.id;
  if (!chatId) throw new Error("No hay una conversación disponible. Crea un chat en Poolside primero.");

  const state = await getChatDirect(chatId);
  const baseMessageId = state.messages?.at(-1)?.id || state.prefixLastMessageId;
  if (!baseMessageId) throw new Error("No se pudo determinar el mensaje base de la conversación.");

  const generationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const requestPayload = {
    chatId,
    model: payload.model || "poolside/laguna-s-2.1",
    inferenceMode: "platform",
    options: {
      webSearch: payload.webSearch !== false,
      thinking: payload.thinking !== false,
      slack: false,
      slackWrite: false
    },
    id: chatId,
    trigger: "submit-message",
    baseMessageId,
    message: { parts: [{ type: "text", text: payload.message }], id: messageId, role: "user" },
    generationId
  };

  const posted = await poolsideRequest("/api/chat", "POST", requestPayload);
  if (!posted.ok) throw new Error(`Poolside rechazó el mensaje (${posted.status}): ${posted.text.slice(0, 300)}`);

  const stream = await (await browserPage()).evaluate(async ({ chatId: id, generationId: generation }) => {
    const response = await fetch(`/api/chat/${id}/stream?generationId=${encodeURIComponent(generation)}`, {
      headers: { accept: "text/event-stream" }
    });
    if (!response.ok || !response.body) return { ok: false, status: response.status };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { ok: true, status: response.status, bytes: text.length };
  }, { chatId, generationId });
  if (!stream.ok) throw new Error(`No se pudo leer el stream de respuesta (${stream.status}).`);

  const finalState = await getChatDirect(chatId);
  const assistant = finalState.messages?.filter((item) => item.role === "assistant").at(-1);
  const response = assistant?.parts?.find((part) => part.type === "text")?.text;
  if (!response) throw new Error("Poolside terminó el stream sin devolver texto.");
  return { chatId, model: requestPayload.model, options: requestPayload.options, response };
}

async function sendMessage(message) {
  const currentPage = await browserPage();
  const input = currentPage.getByRole("textbox");
  if (await input.count() !== 1) {
    throw new Error("Poolside no está listo para recibir mensajes. Inicia sesión en la ventana de Chrome.");
  }

  const paragraphCountBefore = await currentPage.locator("p").count();
  await input.fill(message);
  const send = currentPage.getByRole("button", { name: "Send message" });
  if (await send.count() !== 1) throw new Error("No se encontró el botón de envío.");
  await send.click();

  await currentPage.waitForFunction(
    (count) => document.querySelectorAll("p").length > count,
    paragraphCountBefore,
    { timeout: 120000 }
  );

  const paragraphs = await currentPage.locator("p").allTextContents();
  const response = paragraphs
    .map((text) => text.trim())
    .filter((text) => text && text !== message)
    .at(-1);

  if (!response) throw new Error("Poolside no devolvió una respuesta visible.");
  return response;
}

async function listChats() {
  const currentPage = await browserPage();
  await currentPage.goto(appUrl, { waitUntil: "domcontentloaded" });
  const chats = await currentPage.locator('a[href^="/c/"]').evaluateAll((links) => links.map((link) => {
    const href = link.getAttribute("href") || "";
    return {
      id: href.replace(/^\/c\//, "").split(/[?#]/, 1)[0],
      title: link.textContent?.replace(/\s+/g, " ").trim() || "Sin título",
      url: new URL(href, location.origin).href
    };
  }));
  return chats.filter((chat) => chat.id);
}

async function getChat(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("El id de conversación no es válido.");
  const currentPage = await browserPage();
  await currentPage.goto(`${appUrl.replace(/\/$/, "")}/c/${id}`, { waitUntil: "domcontentloaded" });
  await currentPage.waitForTimeout(500);
  const title = await currentPage.title();
  const transcript = await currentPage.locator("main").innerText();
  const paragraphs = (await currentPage.locator("main p").allTextContents())
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { id, title, transcript, paragraphs, url: currentPage.url() };
}

function enqueue(task) {
  const next = operation.then(task, task);
  operation = next.catch(() => {});
  return next;
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.length > 100_000) throw new Error("El cuerpo de la solicitud es demasiado grande.");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "poolside-browser-api", port, bridge: bridgeIsConnected() });
    }

    if (req.method === "GET" && req.url === "/bridge/next") {
      lastBridgePollAt = Date.now();
      const command = bridgeQueue.shift();
      if (!command) return json(res, 204, {});
      return json(res, 200, command);
    }

    if (req.method === "POST" && req.url === "/bridge/result") {
      const result = await body(req);
      const pending = bridgePending.get(result.id);
      if (!pending) return json(res, 404, { error: "Comando desconocido o expirado." });
      bridgePending.delete(result.id);
      if (result.ok) pending.resolve(result.result);
      else pending.reject(new Error(result.error || "La extensión no pudo completar el comando."));
      return json(res, 202, { accepted: true });
    }

    if (req.method === "GET" && req.url === "/chats") {
      const chats = await enqueue(() => bridgeOrFallback(
        { type: "listChats" },
        listChatsDirect
      ));
      return json(res, 200, { chats });
    }

    const chatMatch = req.method === "GET" && req.url.match(/^\/chats\/([^/?#]+)$/);
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1]);
      const chat = await enqueue(() => bridgeOrFallback(
        { type: "getChat", chatId: id },
        () => getChatDirect(id)
      ));
      return json(res, 200, chat);
    }

    if (req.method === "POST" && req.url === "/message") {
      const payload = await body(req);
      if (typeof payload.message !== "string" || !payload.message.trim()) {
        return json(res, 400, { error: "El campo message es obligatorio y debe ser texto." });
      }

      const messagePayload = { ...payload, message: payload.message.trim() };
      const result = await enqueue(() => bridgeOrFallback(
        { type: "sendMessage", payload: messagePayload },
        () => sendMessageDirect(messagePayload)
      ));
      return json(res, 200, result);
    }

    json(res, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Error interno." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Poolside API escuchando en http://127.0.0.1:${port}`);
  console.log(`POST /message con {"message":"..."}`);
});

async function shutdown() {
  server.close();
  if (context && !connectedViaCdp) await context.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
