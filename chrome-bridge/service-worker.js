const apiBase = "http://127.0.0.1:3100";

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "poolside-command" || !message.command || !sender.tab?.id) return;
  executeCommand(message.command, sender.tab.id).catch(() => {});
});

async function executeCommand(command, tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: runPoolsideCommand,
      args: [command]
    });
    await report(command.id, { ok: true, result: results[0]?.result });
  } catch (error) {
    await report(command.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function report(id, result) {
  const { poolsideApiToken } = await chrome.storage.local.get("poolsideApiToken");
  if (!poolsideApiToken) throw new Error("Configura el token de la API en las opciones de la extensión.");
  await fetch(`${apiBase}/bridge/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-poolside-api-token": poolsideApiToken },
    body: JSON.stringify({ id, ...result })
  });
}

async function runPoolsideCommand(command) {
  const request = async (path, method = "GET", body) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data, text };
  };

  if (command.type === "listChats") {
    const result = await request("/api/chats?limit=100");
    if (!result.ok) throw new Error(`Poolside rechazó el historial (${result.status}).`);
    return (result.data?.recents || []).map((chat) => ({
      id: chat.id,
      title: chat.title || "Sin título",
      updatedAt: chat.updatedAt,
      isGenerating: Boolean(chat.isGenerating),
      url: `${location.origin}/c/${chat.id}`
    }));
  }

  if (command.type === "getChat") {
    const result = await request(`/api/chat/${encodeURIComponent(command.chatId)}/state?tail=100`);
    if (!result.ok) throw new Error(`Poolside rechazó la conversación (${result.status}).`);
    return { id: command.chatId, url: `${location.origin}/c/${command.chatId}`, ...result.data };
  }

  if (command.type === "createChat") {
    const payload = command.payload;
    const result = await request("/api/chats", "POST", {
      title: payload.title,
      model: payload.model || "poolside/laguna-s-2.1",
      inferenceMode: "platform",
      incognito: false
    });
    if (!result.ok) throw new Error(`Poolside no pudo crear la conversación (${result.status}).`);
    const id = result.data?.id || result.data?.chat?.id;
    if (!id) throw new Error("Poolside creó una conversación sin devolver su id.");
    return { id, title: result.data?.title || payload.title, url: `${location.origin}/c/${id}` };
  }

  if (command.type === "sendMessage") {
    const payload = command.payload;
    const chats = await runPoolsideCommand({ type: "listChats" });
    const currentId = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/)?.[1];
    const chatId = payload.chatId || currentId || chats[0]?.id;
    if (!chatId) throw new Error("No hay una conversación disponible.");

    const stateResult = await request(`/api/chat/${chatId}/state?tail=1`);
    const state = stateResult.data || {};
    const baseMessageId = state.messages?.at(-1)?.id || state.prefixLastMessageId;

    const generationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const postBody = {
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
      messageId,
      baseMessageId: baseMessageId || null,
      message: {
        messageId,
        parts: [{ type: "text", text: payload.message }],
        id: messageId,
        role: "user"
      },
      generationId
    };

    const posted = await request("/api/chat", "POST", postBody);
    if (!posted.ok) throw new Error(`Poolside rechazó el mensaje (${posted.status}).`);

    const streamResponse = await fetch(`/api/chat/${chatId}/stream?generationId=${encodeURIComponent(generationId)}`, {
      headers: { accept: "text/event-stream" }
    });
    if (!streamResponse.ok || !streamResponse.body) throw new Error("No se pudo abrir el stream de respuesta.");
    const reader = streamResponse.body.getReader();
    while (!(await reader.read()).done) {}

    const finalResult = await request(`/api/chat/${chatId}/state?tail=1`);
    const assistant = finalResult.data?.messages?.filter((item) => item.role === "assistant").at(-1);
    const response = assistant?.parts?.find((part) => part.type === "text")?.text;
    if (!response) throw new Error("Poolside no devolvió texto.");
    return { chatId, model: postBody.model, options: postBody.options, response };
  }

  throw new Error(`Comando no soportado: ${command.type}`);
}
