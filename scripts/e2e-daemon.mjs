import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

const rootDir = path.resolve(process.cwd());
const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 3_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, description) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof address !== "object" || address === null) {
          reject(new Error("could not allocate a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(port, expected, description) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if ((await canConnect(port)) === expected) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expectRejectedConnection(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve();
    });
    socket.once("error", () => resolve());
    socket.once("open", () => {
      socket.close();
      reject(new Error("unauthorized WebSocket unexpectedly opened"));
    });
  });
}

function receive(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return child?.exitCode ?? null;
  }
  child.kill("SIGTERM");
  try {
    return await withTimeout(waitForExit(child), shutdownTimeoutMs, "daemon SIGTERM exit");
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child);
    throw error;
  }
}

function redact(value, token) {
  return value.replaceAll(token, "[REDACTED]");
}

async function main() {
  const homeDir = mkdtempSync(path.join(tmpdir(), "agent-console-daemon-home-"));
  const cwdDir = mkdtempSync(path.join(tmpdir(), "agent-console-daemon-cwd-"));
  const token = randomBytes(32).toString("hex");
  const port = await allocatePort();
  let child;
  let output = "";

  try {
    child = spawn(process.execPath, [path.join(rootDir, "packages/daemon/dist/index.js"), "--port", String(port)], {
      cwd: cwdDir,
      env: { ...process.env, AGENT_CONSOLE_WS_TOKEN: token, HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    child.once("error", (error) => {
      output += error.message;
    });

    await waitForPort(port, true, "daemon readiness");
    const baseUrl = `ws://127.0.0.1:${port}/`;

    await withTimeout(expectRejectedConnection(baseUrl), startupTimeoutMs, "missing-token rejection");
    await withTimeout(
      expectRejectedConnection(`${baseUrl}?token=wrong-token`),
      startupTimeoutMs,
      "wrong-token rejection",
    );

    const socket = await withTimeout(connect(`${baseUrl}?token=${token}`), startupTimeoutMs, "authorized connection");
    try {
      socket.send(JSON.stringify({ id: 1, method: "providers.list" }));
      const providersResponse = await withTimeout(receive(socket), startupTimeoutMs, "providers.list response");
      assert.equal(providersResponse.ok, true);
      assert.ok(Array.isArray(providersResponse.result.providers));

      socket.send("{");
      const malformedResponse = await withTimeout(receive(socket), startupTimeoutMs, "invalid JSON response");
      assert.equal(malformedResponse.code, "INVALID_JSON");
    } finally {
      socket.close();
    }

    const exitCode = await stopChild(child);
    assert.equal(exitCode, 0);
    child = undefined;
    await waitForPort(port, false, "daemon port closure");
    console.log("[e2e-daemon] token-protected daemon boundary passed");
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[e2e-daemon] failed: ${redact(`${detail}\n${output}`, token)}`);
    throw error;
  } finally {
    try {
      await stopChild(child);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  }
}

main().catch(() => {
  process.exitCode = 1;
});
