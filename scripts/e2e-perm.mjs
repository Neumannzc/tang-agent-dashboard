import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".conn-ok", { timeout: 15000 });
// 用 claude 创建会话
await page.selectOption("select", "claude");
await page.fill('input[placeholder="/tmp 或项目路径"]', "/tmp/agent-test-cwd");
await page.locator("button", { hasText: "创建会话" }).click();
await page.waitForSelector(".session-item", { timeout: 20000 });
await page.waitForTimeout(2500);
// 触发一个需要权限的操作
await page.fill("textarea", "请运行命令 touch /root/agent-console-perm-ui-test.txt 并告诉我结果");
await page.locator("button", { hasText: "发送" }).click();
// 等待权限对话框出现
try {
  await page.waitForSelector(".modal-backdrop", { timeout: 60000 });
  console.log("✓ 权限对话框弹出");
  const desc = await page.textContent(".permission-desc");
  console.log("  权限描述:", desc?.slice(0, 80));
  const kind = await page.textContent(".permission-kind");
  console.log("  权限类型:", kind?.trim());
  // 点击允许
  await page.locator("button", { hasText: "允许" }).click();
  console.log("✓ 已点击允许");
  // 等待对话框消失
  await page.waitForSelector(".modal-backdrop", { state: "detached", timeout: 30000 }).catch(() => console.log("  (对话框未立即消失，继续等回复)"));
} catch {
  console.log("✗ 权限对话框未弹出");
}
// 等待回合结束
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("button")].map(b => b.textContent);
  return !btns.some(t => t.includes("中断"));
}, { timeout: 120000 });
const tl = await page.textContent(".timeline");
console.log("timeline 含权限记录:", tl?.includes("permission") || tl?.includes("工具"));
console.log("E2E 权限流程完成 ✅");
await browser.close();
