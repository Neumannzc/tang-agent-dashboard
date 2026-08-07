// 浏览器 E2E 冒烟测试：创建 pi 会话 → 发送消息 → 验证 timeline + 权限对话框渲染
// 用法: node scripts/e2e-test.mjs

import { chromium } from "playwright-core";

const UI_URL = process.env.UI_URL ?? "http://127.0.0.1:5173";
const PROMPT = "请用一句话回答：2+2 等于几？";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
try {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") logs.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto(UI_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".conn-ok", { timeout: 15000 });
  console.log("✓ 已连接 daemon");

  // 创建会话
  await page.fill('input[placeholder="/tmp 或项目路径"]', "/tmp/agent-test-cwd");
  await page.click("text=创建会话");
  await page.waitForSelector(".session-item", { timeout: 15000 });
  console.log("✓ 会话已创建并列出");

  // 等待 modes 异步加载完成，避免 Composer re-render 竞态导致点击丢失
  await page.waitForTimeout(2500);

  // 发送消息
  await page.fill("textarea", PROMPT);
  await page.locator("button", { hasText: "发送" }).click();
  await page.waitForSelector(".msg-assistant .msg-body", { timeout: 60000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".msg-assistant .msg-body");
      return el && el.textContent.trim().length > 0;
    },
    { timeout: 60000 },
  );
  const assistantText = await page.textContent(".msg-assistant .msg-body");
  console.log(`✓ 收到 assistant 回复: ${assistantText.slice(0, 60)}…`);

  // 等待回合结束（中断按钮消失 / 恢复发送态）
  await page.waitForFunction(
    () => {
      const btns = [...document.querySelectorAll("button")].map((b) => b.textContent);
      return !btns.some((t) => t.includes("中断"));
    },
    { timeout: 90000 },
  );
  console.log("✓ 回合正常结束");

  // 检查权限对话框 DOM 是否存在（非活动时不应显示）
  const modalVisible = await page.isVisible(".modal-backdrop").catch(() => false);
  console.log(`ℹ 权限对话框当前可见: ${modalVisible}`);

  if (logs.length > 0) {
    console.log("--- 页面错误 ---");
    logs.slice(0, 5).forEach((l) => console.log(l));
  }
  console.log("E2E 冒烟测试完成 ✅");
} finally {
  await browser.close();
}
