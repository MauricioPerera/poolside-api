import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const usage = `Uso:
  node examples/local-file-agent.mjs --workspace <carpeta> --file <ruta-relativa> --prompt <instrucción> [opciones]

Opciones:
  --api <url>          API local (predeterminada: http://127.0.0.1:3100)
  --model <id>         Modelo de Poolside
  --overwrite          Permite reemplazar un archivo existente
  --thinking <bool>    true o false (predeterminada: true)
  --web-search <bool>  true o false (predeterminada: false)

Requiere POOLSIDE_API_TOKEN en el entorno. La ruta de --file siempre debe ser
relativa a --workspace; se rechazan rutas fuera de esa carpeta y enlaces simbólicos.`;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--overwrite") {
      values.overwrite = true;
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

function parseBoolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} debe ser true o false.`);
}

async function assertSafeDestination(workspace, relativeFile) {
  if (!relativeFile || isAbsolute(relativeFile)) throw new Error("--file debe ser una ruta relativa.");
  await mkdir(workspace, { recursive: true });
  const workspaceInfo = await lstat(workspace);
  if (workspaceInfo.isSymbolicLink()) throw new Error("--workspace no puede ser un enlace simbólico.");
  const root = await realpath(workspace);
  const destination = resolve(root, relativeFile);
  const fromRoot = relative(root, destination);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("El archivo debe permanecer dentro de --workspace.");
  }

  let current = root;
  for (const segment of dirname(fromRoot).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`No se permiten enlaces simbólicos: ${current}`);
      if (!info.isDirectory()) throw new Error(`El componente no es una carpeta: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return destination;
}

async function apiRequest(apiBase, path, token, method = "GET", body) {
  const response = await fetch(new URL(path, apiBase), {
    method,
    headers: {
      "x-poolside-api-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `La API respondió ${response.status}.`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }

  if (!process.env.POOLSIDE_API_TOKEN) throw new Error("Define POOLSIDE_API_TOKEN antes de ejecutar el agente.");
  if (!args.workspace || !args.file || !args.prompt) throw new Error(`Faltan argumentos obligatorios.\n\n${usage}`);

  const destination = await assertSafeDestination(args.workspace, args.file);
  const apiBase = args.api || "http://127.0.0.1:3100";
  const model = args.model || "poolside/laguna-s-2.1";
  const thinking = parseBoolean(args.thinking, "--thinking", true);
  const webSearch = parseBoolean(args["web-search"], "--web-search", false);
  const chat = await apiRequest(apiBase, "/chats", process.env.POOLSIDE_API_TOKEN, "POST", {
    title: `Agente local: ${args.file}`.slice(0, 1_000),
    model
  });
  const message = [
    "Genera exclusivamente el contenido final para el archivo solicitado.",
    "No uses bloques Markdown, explicaciones, encabezados de conversación ni texto fuera del archivo.",
    `Archivo: ${args.file}`,
    `Instrucción: ${args.prompt}`
  ].join("\n");
  const result = await apiRequest(apiBase, "/message", process.env.POOLSIDE_API_TOKEN, "POST", {
    chatId: chat.id,
    message,
    model,
    thinking,
    webSearch
  });

  const handle = await open(destination, args.overwrite ? "w" : "wx", 0o600);
  try {
    await handle.writeFile(result.response, "utf8");
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify({ chatId: chat.id, file: destination, bytes: Buffer.byteLength(result.response) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
