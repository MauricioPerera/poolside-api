import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.POOLSIDE_API_TOKEN ||= "t".repeat(32);
process.env.POOLSIDE_ALLOWED_ORIGINS ||= "https://chat.poolside.ai";
process.env.POOLSIDE_BRIDGE_DELIVERY_TIMEOUT_MS = "2000";

const { server } = await import("../server.mjs");

const token = process.env.POOLSIDE_API_TOKEN;
let base;

const call = (path, { method = "GET", headers = {}, body, auth = true } = {}) =>
  fetch(new URL(path, base), {
    method,
    headers: {
      ...(auth ? { "x-poolside-api-token": token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe("autenticación y CORS", () => {
  it("expone /health sin token", async () => {
    const response = await call("/health", { auth: false });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.bridge, false);
  });

  it("rechaza rutas protegidas sin token", async () => {
    assert.equal((await call("/chats", { auth: false })).status, 401);
  });

  it("rechaza un token de longitud distinta sin comparar contenido", async () => {
    const response = await call("/chats", { headers: { "x-poolside-api-token": "corto" }, auth: false });
    assert.equal(response.status, 401);
  });

  it("rechaza orígenes no permitidos", async () => {
    const response = await call("/health", { auth: false, headers: { origin: "https://malicioso.example" } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("acepta el origen de Poolside y devuelve encabezados CORS", async () => {
    const response = await call("/health", { auth: false, headers: { origin: "https://chat.poolside.ai" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://chat.poolside.ai");
  });

  it("acepta extensiones con id válido y rechaza orígenes de extensión falsos", async () => {
    const valid = `chrome-extension://${"a".repeat(32)}`;
    assert.equal((await call("/health", { auth: false, headers: { origin: valid } })).status, 200);
    assert.equal((await call("/health", { auth: false, headers: { origin: "chrome-extension://zz" } })).status, 403);
  });

  it("responde al preflight", async () => {
    const response = await call("/chats", {
      method: "OPTIONS",
      auth: false,
      headers: { origin: "https://chat.poolside.ai" }
    });
    assert.equal(response.status, 204);
  });
});

describe("validación de entrada", () => {
  it("devuelve 404 en rutas desconocidas", async () => {
    assert.equal((await call("/desconocida")).status, 404);
  });

  it("rechaza cuerpos que no son JSON", async () => {
    const response = await call("/chats", { method: "POST", body: "{no-json" });
    assert.equal(response.status, 400);
  });

  it("rechaza cuerpos demasiado grandes", async () => {
    const response = await call("/chats", { method: "POST", body: JSON.stringify({ title: "x".repeat(220_000) }) });
    assert.equal(response.status, 413);
  });

  it("rechaza ids de conversación con caracteres no permitidos", async () => {
    const response = await call(`/chats/${encodeURIComponent("../secreto")}`);
    assert.equal(response.status, 400);
  });

  it("rechaza modelos fuera de la lista", async () => {
    const response = await call("/chats", { method: "POST", body: { title: "hola", model: "otro/modelo" } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /modelo/i);
  });

  it("rechaza títulos vacíos", async () => {
    assert.equal((await call("/chats", { method: "POST", body: { title: "   " } })).status, 400);
  });

  it("rechaza adjuntos, que no están implementados", async () => {
    const response = await call("/message", { method: "POST", body: { message: "hola", attachments: [] } });
    assert.equal(response.status, 400);
  });

  it("rechaza un resultado del puente sin id", async () => {
    assert.equal((await call("/bridge/result", { method: "POST", body: { ok: true } })).status, 400);
    assert.equal((await call("/bridge/result", { method: "POST", body: { id: "inexistente", ok: true } })).status, 404);
  });
});

describe("puente de Chrome", () => {
  const poll = async () => {
    const response = await call("/bridge/next");
    return response.status === 204 ? null : response.json();
  };

  it("entrega el comando encolado y resuelve la petición con su resultado", async () => {
    await poll(); // marca el puente como conectado
    const pending = call("/chats");

    let command = null;
    for (let attempt = 0; attempt < 40 && !command; attempt += 1) {
      command = await poll();
      if (!command) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(command, "el puente debería recibir un comando");
    assert.equal(command.type, "listChats");

    const accepted = await call("/bridge/result", {
      method: "POST",
      body: { id: command.id, ok: true, result: [{ id: "abc", title: "Prueba", url: "https://chat.poolside.ai/c/abc" }] }
    });
    assert.equal(accepted.status, 202);

    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).chats, [
      { id: "abc", title: "Prueba", url: "https://chat.poolside.ai/c/abc" }
    ]);
  });

  it("propaga el error informado por la extensión", async () => {
    await poll();
    const pending = call("/chats");
    let command = null;
    for (let attempt = 0; attempt < 40 && !command; attempt += 1) {
      command = await poll();
      if (!command) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await call("/bridge/result", { method: "POST", body: { id: command.id, ok: false, error: "sin sesión" } });
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "sin sesión");
  });

  it("no vuelve a entregar un comando ya resuelto", async () => {
    await poll();
    assert.equal(await poll(), null);
  });

  it("descarta el comando expirado en lugar de entregarlo más tarde", async () => {
    await poll(); // el puente figura como conectado pero deja de sondear
    const response = await call("/chats");
    assert.equal(response.status, 504);

    // Sin la limpieza de la cola, este sondeo entregaría el comando caducado y
    // la extensión ejecutaría un envío que la API ya dio por perdido.
    assert.equal(await poll(), null);
  });

  it("marca el puente como conectado tras un sondeo", async () => {
    await poll();
    assert.equal((await (await call("/health", { auth: false })).json()).bridge, true);
  });
});
