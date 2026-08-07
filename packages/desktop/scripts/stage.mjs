// 打包预处理：把 daemon 产物 + 运行时依赖 + UI 产物 stage 到 packages/desktop/staging/
// electron-builder 再以 staging/ 作为输入打包，确保 packaged 应用离线可跑
//
// 用法: node packages/desktop/scripts/stage.mjs

import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, ".."); // packages/desktop/scripts → packages/desktop
const repoRoot = path.resolve(desktopDir, "../.."); // packages/desktop → repo root

const daemonDir = path.join(repoRoot, "packages/daemon");
const uiDir = path.join(repoRoot, "packages/ui");
const stagingDir = path.join(desktopDir, "staging");

/** 从 workspace 根目录解析模块路径（npm workspaces 会 hoist 到 root） */
function resolveModule(name) {
  const candidates = [
    path.join(repoRoot, "node_modules", name),
    path.join(daemonDir, "node_modules", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 读取 daemon package.json 的运行时依赖（递归解析 transitive deps） */
function collectRuntimeDeps() {
  const pkg = JSON.parse(readFileSync(path.join(daemonDir, "package.json"), "utf8"));
  const deps = new Map();
  const queue = [...Object.keys(pkg.dependencies ?? {})];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const resolved = resolveModule(name);
    if (!resolved) {
      console.warn(`[stage] 跳过（未找到）: ${name}`);
      continue;
    }
    deps.set(name, resolved);
    const subPkgPath = path.join(resolved, "package.json");
    if (!existsSync(subPkgPath)) {
      continue;
    }
    try {
      const subPkg = JSON.parse(readFileSync(subPkgPath, "utf8"));
      for (const sub of Object.keys(subPkg.dependencies ?? {})) {
        if (!seen.has(sub)) {
          queue.push(sub);
        }
      }
    } catch {
      // ignore broken sub pkg
    }
  }
  return deps;
}

/** 复制 daemon dist（剔除声明文件与 sourcemap） */
function stageDaemonDist() {
  const src = path.join(daemonDir, "dist");
  const dst = path.join(stagingDir, "daemon/dist");
  if (!existsSync(src)) {
    throw new Error(`daemon dist 缺失：${src}（请先 npm run build -w @agent-console/daemon）`);
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry.endsWith(".d.ts") || entry.endsWith(".map")) {
      continue;
    }
    cpSync(path.join(src, entry), path.join(dst, entry), { recursive: true });
  }
  console.log(`[stage] daemon/dist → ${dst}`);
}

/** 复制 daemon 的 package.json（type: module 决定 dist 以 ESM 加载） */
function stageDaemonPackageJson() {
  const dst = path.join(stagingDir, "daemon/package.json");
  cpSync(path.join(daemonDir, "package.json"), dst);
  console.log(`[stage] daemon/package.json → ${dst}`);
}

/** 复制 daemon 运行时依赖到 staging/daemon/node_modules */
function stageDaemonNodeModules() {
  const dst = path.join(stagingDir, "daemon/node_modules");
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const deps = collectRuntimeDeps();
  for (const [name, src] of deps) {
    const scopedDir = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name;
    const target = path.join(dst, scopedDir);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(src, target, { recursive: true, dereference: true });
    console.log(`[stage] ${name}`);
  }
}

/** 复制 UI 构建产物到 staging/app-dist */
function stageUiDist() {
  const src = path.join(uiDir, "dist");
  const dst = path.join(stagingDir, "app-dist");
  if (!existsSync(src)) {
    throw new Error(`UI dist 缺失：${src}（请先 npm run build -w @agent-console/ui）`);
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[stage] app-dist → ${dst}`);
}

function main() {
  console.log("[stage] 准备 staging 目录");
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  stageDaemonDist();
  stageDaemonPackageJson();
  stageDaemonNodeModules();
  stageUiDist();
  const size = (function dirSize(p) {
    let total = 0;
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d)) {
        const full = path.join(d, e);
        const s = statSync(full);
        if (s.isDirectory()) walk(full);
        else total += s.size;
      }
    };
    walk(p);
    return total;
  })(stagingDir);
  console.log(`[stage] 完成（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

try {
  main();
} catch (error) {
  console.error("[stage] 失败:", error);
  process.exit(1);
}