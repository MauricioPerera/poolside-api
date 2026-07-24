import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const usage = `Uso:
  node examples/delegated-workspace-agent.mjs --workspace <carpeta> --task <instrucción> [opciones]

Opciones:
  --context <rutas>     Archivos relativos separados por coma que el subagente puede leer
  --apply                Escribe los cambios propuestos; sin esta opción solo muestra el plan
  --overwrite            Permite reemplazar archivos existentes (requiere --apply)
  --api <url>            API local (predeterminada: http://127.0.0.1:3100)
  --model <id>           Modelo de Poolside

Requiere POOLSIDE_API_TOKEN. Todas las rutas se limitan a --workspace.`;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--apply" || argument === "--overwrite") {
      values[argument.slice(2)] = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Argumento no reconocido: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Falta el valor para ${argument}`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function prepareWorkspace(workspace) {
  await mkdir(workspace, { recursive: true });
  const info = await lstat(workspace);
  if (info.isSymbolicLink()) throw new Error("--workspace no puede ser un enlace simbólico.");
  return realpath(workspace);
}

async function safePath(root, relativeFile, { createParents = false } = {}) {
  if (!relativeFile || isAbsolute(relativeFile)) throw new Error("Las rutas deben ser relativas.");
  const destination = resolve(root, relativeFile);
  const fromRoot = relative(root, destination);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Ruta fuera del espacio autorizado: ${relativeFile}`);
  }
  let current = root;
  for (const segment of dirname(fromRoot).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Carpeta insegura: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT" || !createParents) throw error;
      await mkdir(current);
    }
  }
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) throw new Error(`No se permiten enlaces simbólicos: ${relativeFile}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return destination;
}

async function apiRequest(base, path, token, method = "GET", body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "x-poolside-api-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `La API respondió ${response.status}.`);
  return result;
}

function parsePlan(response) {
  const candidate = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const plan = JSON.parse(candidate);
  if (!plan || typeof plan.summary !== "string" || !Array.isArray(plan.changes)) {
    throw new Error("El subagente devolvió un plan con formato inválido.");
  }
  for (const change of plan.changes) {
    if (!change || typeof change.path !== "string" || typeof change.content !== "string") {
      throw new Error("El subagente propuso un cambio inválido.");
    }
  }
  return plan;
}

async function readContext(root, context) {
  const paths = context ? context.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const entries = [];
  let totalBytes = 0;
  for (const path of paths) {
    const target = await safePath(root, path);
    const content = await readFile(target, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > 200_000) throw new Error("El contexto supera el límite de 200 KB.");
    entries.push({ path, content });
  }
  return entries;
}

async function applyPlan(root, changes, overwrite) {
  const written = [];
  for (const change of changes) {
    const target = await safePath(root, change.path, { createParents: true });
    const handle = await open(target, overwrite ? "w" : "wx", 0o600);
    try { await handle.writeFile(change.content, "utf8"); } finally { await handle.close(); }
    written.push(target);
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage);
  if (!process.env.POOLSIDE_API_TOKEN) throw new Error("Define POOLSIDE_API_TOKEN antes de ejecutar el subagente.");
  if (!args.workspace || !args.task) throw new Error(`Faltan argumentos obligatorios.\n\n${usage}`);
  if (args.overwrite && !args.apply) throw new Error("--overwrite requiere --apply.");

  const root = await prepareWorkspace(args.workspace);
  const context = await readContext(root, args.context);
  const base = args.api || "http://127.0.0.1:3100";
  const model = args.model || "poolside/laguna-s-2.1";
  const chat = await apiRequest(base, "/chats", process.env.POOLSIDE_API_TOKEN, "POST", {
    title: `Subagente: ${args.task}`.slice(0, 1_000), model
  });
  const prompt = [
    "Actúa como subagente de implementación. Propón cambios solo dentro del proyecto autorizado.",
    "Devuelve exclusivamente JSON válido con este formato:",
    '{"summary":"...","changes":[{"path":"ruta/relativa.ext","content":"contenido completo del archivo"}]}',
    "No propongas borrados, comandos del sistema, enlaces simbólicos ni rutas absolutas.",
    "Los cambios contienen el contenido completo de cada archivo. Si no se requiere ningún archivo, usa changes: [].",
    `Tarea: ${args.task}`,
    `Contexto autorizado: ${JSON.stringify(context)}`
  ].join("\n\n");
  const result = await apiRequest(base, "/message", process.env.POOLSIDE_API_TOKEN, "POST", {
    chatId: chat.id, message: prompt, model, thinking: true, webSearch: false
  });
  const plan = parsePlan(result.response);
  if (!args.apply) {
    console.log(JSON.stringify({ chatId: chat.id, dryRun: true, ...plan }, null, 2));
    return;
  }
  const files = await applyPlan(root, plan.changes, Boolean(args.overwrite));
  console.log(JSON.stringify({ chatId: chat.id, applied: true, summary: plan.summary, files }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
