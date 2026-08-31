// crawlDetail.js (ESM)
// Purpose: Read app list JSON, visit each detail page, collect categories from
//          category elements (class="category-button" or class="category button"),
//          and write updated JSON.
// Usage:
//   node crawlDetail.js
//   node crawlDetail.js --in "./result/apps_free.json"
//   node crawlDetail.js --in "./result/apps_free.json" --out "./result/apps_free.json" --limit 5

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

function parseCLI(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq !== -1) out[tok.slice(2, eq)] = tok.slice(eq + 1);
    else {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

const args = parseCLI(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_IN = path.resolve("result", "apps_free.json");
const DELAY_MS = Number(args.delay || 800);
const LIMIT = args.limit ? Number(args.limit) : Infinity;

function normalizeItem(raw) {
  return {
    itemName: raw.itemName ?? raw.itemname ?? "",
    itemID: raw.itemID ?? raw.itemid ?? "",
    href: raw.href ?? "",
    categories: Array.isArray(raw.categories) ? raw.categories : [],
  };
}

async function extractCategories(page) {
  return page.evaluate(() => {
    function* walk(root = document) {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
        if (node.children) {
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
      }
    }

    const isCategoryElement = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const cls = (el.getAttribute("class") || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (cls.includes("category-button")) return true;
      return cls.includes("category") && cls.includes("button");
    };

    const seen = new Set();
    const categories = [];

    for (const node of walk()) {
      if (!isCategoryElement(node)) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      categories.push(text);
    }

    return categories;
  });
}

async function crawlDetailPage(browser, href) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-NL,en-GB;q=0.9" });
    await page.setViewport({ width: 1366, height: 900 });

    await page.goto(href, { waitUntil: "networkidle2", timeout: 120_000 });
    await sleep(1200);

    return await extractCategories(page);
  } finally {
    await page.close();
  }
}

async function main() {
  const inFile = args.in ? path.resolve(args.in) : DEFAULT_IN;
  const outFile = args.out ? path.resolve(args.out) : inFile;
  const skipExisting = args.skipExisting !== "false";

  if (!fs.existsSync(inFile)) {
    throw new Error(`Input file not found: ${inFile}`);
  }

  const rawItems = JSON.parse(fs.readFileSync(inFile, "utf-8"));
  if (!Array.isArray(rawItems)) {
    throw new Error(`Expected JSON array in ${inFile}`);
  }

  const items = rawItems.map(normalizeItem);
  const targets = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.href)
    .filter(({ item }) => !skipExisting || item.categories.length === 0)
    .slice(0, LIMIT);

  if (!targets.length) {
    console.log("No items to crawl (all already have categories or no href values).");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(items, null, 2), "utf-8");
    console.log(`Saved ${items.length} items to ${outFile}`);
    return;
  }

  console.log(`Crawling categories for ${targets.length} item(s) from ${inFile}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    for (let i = 0; i < targets.length; i++) {
      const { item, index } = targets[i];
      console.log(`[${i + 1}/${targets.length}] ${item.itemName || item.itemID} -> ${item.href}`);

      try {
        item.categories = await crawlDetailPage(browser, item.href);
        items[index] = item;
        console.log(`  categories: ${item.categories.length ? item.categories.join(", ") : "(none)"}`);
      } catch (err) {
        console.error(`  failed: ${err.message}`);
        items[index] = item;
      }

      if (i < targets.length - 1) await sleep(DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2), "utf-8");
  console.log(`Saved ${items.length} items to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
