import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const { applyPlan, assertAllowedChanges, assertWritable, parsePlan, safePath, toMatcher } =
  await import("../examples/delegated-workspace-agent.mjs");
const { touchOnly } = await import("../examples/kdd-coding-subagent.mjs");

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "poolside-agent-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("perímetro de escritura", () => {
  it("bloquea rutas que dan ejecución de código aunque estén en el workspace", async () => {
    for (const path of [
      ".git/hooks/pre-commit",
      "sub/.git/config",
      ".github/workflows/ci.yml",
      "package.json",
      "node_modules/x/index.js",
      ".env"
    ]) {
      assert.throws(() => assertWritable(path), /protegid/i, path);
    }
  });

  it("bloquea también con separadores de Windows", () => {
    assert.throws(() => assertWritable(".git\\hooks\\pre-commit"), /protegid/i);
  });

  it("permite rutas normales del proyecto", () => {
    for (const path of ["src/app.js", "docs/README.md", "a/b/c.txt"]) {
      assert.doesNotThrow(() => assertWritable(path));
    }
  });

  it("rechaza el plan completo si propone una ruta protegida", () => {
    const response = JSON.stringify({ summary: "x", changes: [{ path: ".git/hooks/pre-commit", content: "rm -rf" }] });
    assert.throws(() => parsePlan(response), /protegid/i);
  });

  it("acepta un plan válido, con o sin valla de Markdown", () => {
    const plan = { summary: "x", changes: [{ path: "src/a.js", content: "export const a = 1;" }] };
    assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
    assert.deepEqual(parsePlan("```json\n" + JSON.stringify(plan) + "\n```"), plan);
  });
});

describe("rutas fuera del workspace", () => {
  it("rechaza escapes y rutas absolutas", async () => {
    await assert.rejects(() => safePath(root, "../fuera.txt"), /fuera del espacio/i);
    await assert.rejects(() => safePath(root, "a/../../fuera.txt"), /fuera del espacio/i);
    await assert.rejects(() => safePath(root, "/etc/passwd"), /relativas/i);
  });
});

describe("coincidencia de --allow y touch_only", () => {
  const matches = (pattern, path) => toMatcher(pattern).test(path);

  it("acepta rutas exactas", () => {
    assert.equal(matches("src/app.js", "src/app.js"), true);
    assert.equal(matches("src/app.js", "src/otro.js"), false);
  });

  it("no trata los puntos como comodín", () => {
    assert.equal(matches("a.b", "axb"), false);
  });

  it("soporta comodines dentro de un segmento", () => {
    assert.equal(matches("docs/*.md", "docs/guia.md"), true);
    assert.equal(matches("docs/*.md", "docs/sub/guia.md"), false);
  });

  it("soporta subárboles completos", () => {
    assert.equal(matches("src/**", "src/a/b/c.js"), true);
    assert.equal(matches("src/**", "src"), true);
    assert.equal(matches("src/**", "otro/a.js"), false);
    assert.equal(matches("src/", "src/a.js"), true);
  });

  it("rechaza cambios fuera del perímetro y acepta los que encajan", () => {
    const changes = [{ path: "src/a/b.js", content: "" }];
    assert.doesNotThrow(() => assertAllowedChanges(changes, "src/**"));
    assert.throws(() => assertAllowedChanges(changes, "docs/**"), /perímetro/i);
    assert.doesNotThrow(() => assertAllowedChanges(changes, undefined));
  });
});

describe("touch_only del Task Contract KDD", () => {
  it("lee la lista en línea", () => {
    assert.deepEqual(touchOnly('touch_only: ["src/a.py", \'src/b.py\']\n'), ["src/a.py", "src/b.py"]);
  });

  it("lee la lista en bloque YAML", () => {
    const contract = "task: demo\ntouch_only:\n  - src/a.py\n  - \"src/b.py\"\nintent: algo\n";
    assert.deepEqual(touchOnly(contract), ["src/a.py", "src/b.py"]);
  });

  it("rechaza contratos sin touch_only o con la lista vacía", () => {
    assert.throws(() => touchOnly("task: demo\n"), /no define touch_only/i);
    assert.throws(() => touchOnly("touch_only: []\n"), /no puede estar vacío/i);
  });
});

describe("aplicación del plan", () => {
  it("escribe los archivos propuestos creando carpetas intermedias", async () => {
    const written = await applyPlan(root, [{ path: "src/nuevo.js", content: "ok" }], false);
    assert.equal(written.length, 1);
    assert.equal(await readFile(join(root, "src", "nuevo.js"), "utf8"), "ok");
  });

  it("no reemplaza un archivo existente sin --overwrite", async () => {
    await assert.rejects(
      () => applyPlan(root, [{ path: "src/nuevo.js", content: "otro" }], false),
      /ya existe/i
    );
    assert.equal(await readFile(join(root, "src", "nuevo.js"), "utf8"), "ok");
  });

  it("no deja escrituras a medias si un cambio del plan falla", async () => {
    await mkdir(join(root, "ocupado"), { recursive: true });
    await writeFile(join(root, "intacto.txt"), "original", "utf8");
    const changes = [
      { path: "creado-y-revertido.txt", content: "temporal" },
      { path: "ocupado", content: "esto no puede escribirse sobre una carpeta" }
    ];
    await assert.rejects(() => applyPlan(root, changes, true));
    await assert.rejects(() => readFile(join(root, "creado-y-revertido.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "intacto.txt"), "utf8"), "original");
  });
});
