// 桌面版 E2E 冒烟测试：Electron 窗口内完成「创建会话 → 发消息 → 验证 timeline」
// 用法（先构建三包）: npm run build && node scripts/e2e-desktop.mjs
// 依赖 playwright-core 的 _electron 启动器（无需 chrome）

import { _electron as electron } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const desktopEntry = path.join(rootDir, "packages/desktop");
const PROMPT = "请用一句话回答：2+2 等于几？";

// 可用 E2E_EXECUTABLE 指定打包后的二进制（验证 packaged 产物）
const packagedBinary = process.env.E2E_EXECUTABLE;
const args = packagedBinary
  ? [] // 打包二进制直接启动
  : [desktopEntry, "--prod-ui"];
const electronBinary = packagedBinary
  ?? path.join(rootDir, "node_modules", ".bin", "electron");

async function main() {
  console.log("[e2e-desktop] 启动 Electron（桌面壳拉起 daemon）...");
  const app = await electron.launch({
    executablePath: electronBinary,
    args,
    env: {
      ...process.env,
      // 固定测试端口，避免与默认 8765 或其他实例冲突
      AGENT_CONSOLE_PORT: "8771",
    },
    timeout: 60000,
  });

  const page = await app.firstWindow();
  const logs = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") logs.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  // 等待 UI 加载（协议资源或 Vite）
  await page.waitForSelector(".conn-ok, .dot", { timeout: 30000 });
  console.log("✓ 窗口已加载");

  // 等 renderer 通过 preload 连上 daemon
  await page.waitForFunction(
    () => document.querySelector(".foot-sub")?.textContent?.includes("已连接") ?? false,
    { timeout: 30000 },
  );
  console.log("✓ renderer 已通过 preload 连接 daemon");

  // 创建 workspace（用系统临时目录，避免污染）
  const cwd = `/tmp/agent-e2e-${Date.now()}`;
  mkdirSync(cwd, { recursive: true }); // daemon 校验 cwd 必须存在
  await page.click(".btn-new");
  await page.waitForSelector(".modal input");
  // React 受控输入需通过 native setter + input 事件驱动状态
  await page.evaluate((value) => {
    const input = document.querySelector(".modal input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, cwd);
  await page.waitForFunction(
    () => !document.querySelector(".modal-foot button.btn-primary")?.hasAttribute("disabled"),
  );
  await page.click(".modal-foot button.btn-primary");
  await page.waitForSelector(".ws-item", { timeout: 15000 });
  console.log("✓ workspace 已创建");

  // 创建会话（默认 pi）——用 tabs 行的 + 按钮（.tab-add）打开会话模态
  await page.click(".tab-add");
  await page.waitForSelector(".modal .p-card", { timeout: 15000 });
  await page.click(".modal-foot button.btn-primary");
  try {
    await page.waitForSelector(".tab", { timeout: 30000 });
  } catch (err) {
    // 收集错误信息辅助诊断
    const diag = await page.evaluate(() =>
      JSON.stringify({
        modal: document.querySelector(".modal")?.textContent?.slice(0, 120),
        error: document.querySelector(".msg-error")?.textContent,
        tabs: [...document.querySelectorAll(".tab")].map((t) => t.textContent),
        body: document.body.innerText.slice(0, 300),
      }),
    );
    console.error("[e2e] 会话创建诊断:", diag);
    throw err;
  }
  console.log("✓ 会话已创建");

  // 等待 modes 异步加载完成
  await page.waitForTimeout(2500);

  // 发送消息（send 按钮是图标按钮，用 title 定位；textarea 受控需 native setter）
  await page.evaluate((prompt) => {
    const textarea = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, PROMPT);
  await page.waitForFunction(
    () => !document.querySelector(".send")?.hasAttribute("disabled"),
    { timeout: 5000 },
  );
  await page.click(".send");
  await page.waitForSelector(".msg .body .md", { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".msg .body .md");
      return el && el.textContent.trim().length > 0;
    },
    { timeout: 60000 },
  );
  const assistantText = await page.textContent(".msg .body .md");
  console.log(`✓ 收到 assistant 回复: ${assistantText.slice(0, 60)}…`);

  // 等待回合结束
  await page.waitForFunction(
    () => {
      const btns = [...document.querySelectorAll("button")].map((b) => b.textContent);
      return !btns.some((t) => t.includes("中断"));
    },
    { timeout: 120000 },
  );
  console.log("✓ 回合正常结束");

  if (logs.length > 0) {
    console.log("--- 页面错误 ---");
    logs.slice(0, 5).forEach((l) => console.log(l));
  }

  console.log("E2E 桌面冒烟测试完成 ✅");
  await app.close();
}

main().catch((error) => {
  console.error("E2E 失败:", error);
  process.exit(1);
});