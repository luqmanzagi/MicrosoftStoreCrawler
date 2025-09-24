// collectionPageCrawler.js (ESM)
// Purpose: Crawl a specific Microsoft Store collection page and extract:
//          - title: from <p class="title title text-two-line-overflow">
//          - href:  from the nearest <a> (ancestor or descendant)
// Usage:
//   node collectionPageCrawler.js
//   node collectionPageCrawler.js --url "<another collection url>"
// Output: collection_page_items.json  => [{ title, href }]

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrollToAbsoluteBottom(page, { maxRounds = 40, idleMs = 1500, afterClicksIdleMs = 2500 } = {}) {
  let lastHeight = 0, stableRounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const clicks = await page.evaluate(() => {
      const tryClick = (el) => { try { el.click(); return true; } catch { return false; } };
      const looksLikeMore = (el) => {
        const t = (el.textContent || "").toLowerCase();
        const aria = (el.getAttribute?.("aria-label") || "").toLowerCase();
        return /\b(show|see|load)\s+more\b/.test(t) || /\bmore\b/.test(t) || /expand/.test(aria);
      };
      const deep = [];
      const pushKids = (root) => {
        if (!root) return;
        if (root.querySelectorAll) deep.push(...root.querySelectorAll("*"));
        if (root.children) for (const c of root.children) if (c.shadowRoot) pushKids(c.shadowRoot);
        if (root.shadowRoot) pushKids(root.shadowRoot);
      };
      pushKids(document);
      let clicked = 0;
      for (const el of deep) {
        const role = el.getAttribute?.("role");
        const tag = (el.tagName || "").toLowerCase();
        if (looksLikeMore(el) && (tag === "button" || tag === "a" || role === "button")) {
          if (tryClick(el)) clicked++;
        }
      }
      return clicked;
    });
    if (clicks > 0) await sleep(afterClicksIdleMs);

    await page.evaluate(() => {
      const step = Math.max(600, Math.floor(window.innerHeight * 0.9));
      for (let i = 0; i < 25; i++) window.scrollBy(0, step);
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(idleMs);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= lastHeight) stableRounds++; else { stableRounds = 0; lastHeight = newHeight; }
    if (stableRounds >= 3) break;
  }
}

async function extractItems(page) {
  let items = await page.evaluate(() => {
    const arr = [];
    const nodes = document.querySelectorAll("p.title.title.text-two-line-overflow");
    for (const p of nodes) {
      const anchor = p.closest("a") || p.querySelector("a") || p.parentElement?.querySelector?.("a") || null;
      const title = p.textContent?.trim() || "";
      const href = anchor?.href || anchor?.getAttribute?.("href") || "";
      if (title && href) arr.push({ title, href });
    }
    return arr;
  });

  try {
    const handles = await page.$$('pierce/p.title.title.text-two-line-overflow');
    if (handles?.length) {
      const more = await page.evaluate((els) => {
        const out = [];
        for (const p of els) {
          const title = p.textContent?.trim() || "";
          let a = p.closest?.("a") || p.querySelector?.("a") || p.parentElement?.querySelector?.("a") || null;
          const href = a?.href || a?.getAttribute?.("href") || "";
          if (title && href) out.push({ title, href });
        }
        return out;
      }, handles);
      items.push(...more);
    }
  } catch {}

  const deep = await page.evaluate(() => {
    function* walk(root = document) {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
        if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      }
    }
    const needClasses = ["title", "text-two-line-overflow"];
    const matchesTargetP = (el) => {
      if (!el || el.tagName !== "P") return false;
      const cls = (el.getAttribute("class") || "").toLowerCase().split(/\s+/);
      return needClasses.every((c) => cls.includes(c));
    };
    const results = [];
    const seen = new Set();
    for (const node of walk()) {
      if (matchesTargetP(node)) {
        const title = node.textContent?.trim() || "";
        let a = node.closest?.("a") || node.querySelector?.("a") || node.parentElement?.querySelector?.("a") || null;
        const href = a?.href || a?.getAttribute?.("href") || "";
        const key = href + "||" + title;
        if (title && href && !seen.has(key)) { results.push({ title, href }); seen.add(key); }
      }
    }
    return results;
  });
  items.push(...deep);

  const map = new Map();
  for (const it of items) {
    if (!it?.href || !it?.title) continue;
    const key = `${it.href}||${it.title}`;
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

async function main() {
  const argStr = process.argv.slice(2).join("&");
  const args = Object.fromEntries(new URLSearchParams(argStr));
  const url = args.url || "https://apps.microsoft.com/collections/browse/MerchandiserContent/Apps/Collection-C/CollectionCAppsPage?hl=en-US&gl=US";

  // NEW: output config
  const outDir = args.outDir || "result";
  const outName = args.out || "collection_page_items.json";
  const outPath = path.resolve(outDir, outName);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1366, height: 900 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120_000 });
    // try { await page.click('button:has-text("Accept")', { timeout: 3000 }); } catch {}

    await scrollToAbsoluteBottom(page, { maxRounds: 50 });
    const items = await extractItems(page);

    // ensure ./result exists
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(items, null, 2), "utf-8");
    console.log(`Saved ${items.length} items to ${outPath}`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });