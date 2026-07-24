import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const usage = `Uso:
  node examples/kdd-coding-subagent.mjs --kdd-root <clon-KDD> --contract <ruta-relativa> [--apply] [--overwrite]

El wrapper obtiene touch_only del Task Contract y delega solo dentro de ese perímetro.`;

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--apply" || arg === "--overwrite") { values[arg.slice(2)] = true; continue; }
    if (!arg.startsWith("--") || !argv[i + 1]) throw new Error(`Argumento inválido: ${arg}`);
    values[arg.slice(2)] = argv[++i];
  }
  return values;
}

function safeRelative(root, path) {
  if (!path || isAbsolute(path)) throw new Error("La ruta del contrato debe ser relativa.");
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Contrato fuera del clon KDD.");
  return target;
}

function touchOnly(contract) {
  const clean = (item) => item.trim().replace(/^['"]|['"]$/g, "");
  const inline = contract.match(/^touch_only:\s*\[([^\]]*)\]/m);
  let paths;
  if (inline) {
    paths = inline[1].split(",").map(clean).filter(Boolean);
  } else {
    // Los contratos también pueden escribir touch_only como lista YAML en bloque.
    const block = contract.match(/^touch_only:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m);
    if (!block) throw new Error("El contrato no define touch_only en formato de lista.");
    paths = block[1].split(/\r?\n/).map((line) => line.replace(/^[ \t]*-[ \t]*/, "")).map(clean).filter(Boolean);
  }
  if (!paths.length) throw new Error("touch_only no puede estar vacío para un subagente codificador.");
  return paths;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage);
  if (!args["kdd-root"] || !args.contract) throw new Error(`Faltan argumentos obligatorios.\n\n${usage}`);
  const root = await realpath(args["kdd-root"]);
  const contractPath = safeRelative(root, args.contract);
  const contract = await readFile(contractPath, "utf8");
  const allowed = touchOnly(contract);
  const assembled = spawnSync("python", ["scripts/assemble_context.py", "ccdd/context.json", args.contract], {
    cwd: root, encoding: "utf8", maxBuffer: 1_000_000
  });
  if (assembled.error || assembled.status !== 0) {
    throw new Error(`KDD bloqueó la delegación al ensamblar contexto: ${assembled.stderr || assembled.error?.message || "exit no cero"}`);
  }
  const context = [".agents/AGENTS.md", "knowledge/OKF-SPEC.md", args.contract, ...allowed].join(",");
  const task = [
    "Implementa el siguiente Task Contract KDD sin salir de touch_only.",
    "Respeta sus invariantes, constraints, tests y enlaces OKF.",
    `Contexto presupuestado KDD:\n${assembled.stdout}`,
    contract
  ].join("\n\n");
  const delegate = fileURLToPath(new URL("./delegated-workspace-agent.mjs", import.meta.url));
  const delegateArgs = [delegate, "--workspace", root, "--context", context, "--allow", allowed.join(","), "--task", task];
  if (args.apply) delegateArgs.push("--apply");
  if (args.overwrite) delegateArgs.push("--overwrite");
  const result = spawnSync(process.execPath, delegateArgs, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

export { safeRelative, touchOnly };
