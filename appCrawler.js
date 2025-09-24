// appCrawler.js (ESM) — product-card aware (square-card + price-badge inside shadow DOM)
// Usage examples:
//   node appCrawler.js --url "https://apps.microsoft.com/collections/..." --limit 50
//   node appCrawler.js --in "./result/collection_page_items.json" --limit 50
//   node appCrawler.js --out "./result/apps_free.json"
// Tip: add { "type": "module" } to package.json to silence ESM warnings.

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
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

const args = parseCLI(process.argv.slice(2));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULT_IN  = path.resolve("result", "collection_page_items.json"); // optional list of {href}
const DEFAULT_OUT = path.resolve("result", "apps_free.json");
const LIMIT = Number(args.limit || 50);

function extractItemIdFromHref(href) {
  try {
    const u = new URL(href);
    const segs = u.pathname.split("/").filter(Boolean);
    // expect /detail/<id> or /detail/<name>/<id>
    const last = segs[segs.length - 1] || "";
    const prev = segs[segs.length - 2] || "";
    let candidate = /detail/i.test(prev) ? last : last;
    candidate = candidate.split("?")[0].split("#")[0];
    // known SKU-style or GUID
    const guid = candidate.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (guid) return guid[0];
    const sku  = candidate.match(/[A-Z0-9]{8,20}/i);
    if (sku) return sku[0];
    return candidate || href;
  } catch { return href; }
}

async function scrollUntilLoaded(page, wantCount = 50, { maxRounds = 80, idleMs = 1200 } = {}) {
  let lastHeight = 0, stable = 0;
  for (let round = 1; round <= maxRounds; round++) {
    // aggressive scroll burst
    await page.evaluate(() => {
      const step = Math.max(700, Math.floor(window.innerHeight * 0.95));
      for (let i = 0; i < 30; i++) window.scrollBy(0, step);
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(idleMs);

    // estimate number of product cards currently in DOM (deep)
    const count = await page.evaluate(() => {
      function* walk(root = document) {
        const stack = [root];
        while (stack.length) {
          const n = stack.pop();
          if (!n) continue;
          yield n;
          if (n.shadowRoot) stack.push(n.shadowRoot);
          if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
        }
      }
      let c = 0;
      for (const n of walk()) {
        if (n.nodeType === 1 && n.localName === "square-card") {
          if ((n.getAttribute("class") || "").toLowerCase().includes("product-card")) c++;
        }
      }
      return c;
    });
    if (count >= wantCount) break;

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= lastHeight) stable++; else { stable = 0; lastHeight = newHeight; }
    if (stable >= 3) break;
  }
}

async function scrapeFreeProductCards(page, limit = 50) {
  const items = await page.evaluate(({ limit }) => {
    const ORIGIN = location.origin; // "https://apps.microsoft.com"
    const results = [];
    const seen = new Set();

    // helpers (deep walk; climb across shadow boundaries)
    function* walk(root = document) {
      const stack = [root];
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        yield n;
        if (n.shadowRoot) stack.push(n.shadowRoot);
        if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
      }
    }
    function climb(node) {
      const out = [];
      let cur = node;
      while (cur) {
        out.push(cur);
        if (cur.parentElement) { cur = cur.parentElement; continue; }
        const root = cur.getRootNode?.();
        if (root && root instanceof ShadowRoot && root.host) { cur = root.host; continue; }
        break;
      }
      return out;
    }

    const FREE_RE = /\bfree\b/i;

    // Find all <square-card class="product-card"> even if they sit inside other web components
    const cards = [];
    for (const n of walk()) {
      if (n.nodeType !== 1) continue;
      if (n.localName === "square-card" && (n.getAttribute("class") || "").toLowerCase().includes("product-card")) {
        cards.push(n);
      }
    }

    for (const card of cards) {
      const root = card.shadowRoot;
      if (!root) continue;

      // price: <price-badge> has its own shadowRoot; inside it a div[part="price-container"]
      let priceText = "";
      const priceBadge = root.querySelector("price-badge");
      if (priceBadge?.shadowRoot) {
        const pc = priceBadge.shadowRoot.querySelector('div[part="price-container"]') ||
                   priceBadge.shadowRoot.querySelector(".price-container");
        if (pc) priceText = (pc.textContent || "").replace(/\s+/g, " ").trim();
      } else {
        // fallback: sometimes price-container is slotted up
        const pc = root.querySelector('div[part="price-container"], .price-container');
        if (pc) priceText = (pc.textContent || "").replace(/\s+/g, " ").trim();
      }
      if (!FREE_RE.test(priceText)) continue; // only free

      // anchor & href inside the card’s shadow
      const a = root.querySelector('a[href*="/detail/"]');
      if (!a) continue;
      const relHref = a.getAttribute("href") || "";
      if (!relHref) continue;
      const absHref = new URL(relHref, ORIGIN).href;
      if (!absHref.startsWith("https://apps.microsoft.com")) continue;

      // title
      let itemName = "";
      const titleEl = root.querySelector('p[part="title"], p.title, [part="title"]');
      if (titleEl) itemName = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      if (!itemName) {
        // fallback: use anchor text
        itemName = (a.textContent || "").replace(/\s+/g, " ").trim();
      }
      if (!itemName) {
        // last resort: parse from telemetry-data attribute on <square-card>
        const t = card.getAttribute("telemetry-data");
        if (t) {
          try {
            const json = JSON.parse(t.replace(/&quot;/g, '"'));
            if (json?.itemName) itemName = String(json.itemName);
          } catch {}
        }
      }

      // itemId from href or telemetry-data
      let itemId = "";
      const t = card.getAttribute("telemetry-data");
      if (t) {
        try {
          const json = JSON.parse(t.replace(/&quot;/g, '"'));
          if (json?.itemId) itemId = String(json.itemId);
        } catch {}
      }
      if (!itemId) {
        // from href (/detail/<id> or /detail/<name>/<id>)
        const m = absHref.match(/\/detail\/(?:[^/]+\/)?([^/?#]+)/i);
        if (m) itemId = m[1];
      }

      if (!itemName || !itemId) continue;

      const key = absHref.toUpperCase();
      if (!seen.has(key)) {
        results.push({ itemName, itemID: itemId, href: absHref });
        seen.add(key);
      }
      if (results.length >= limit) break;
    }

    return results;
  }, { limit });

  // Ensure unique + cap (already capped, but keep safe)
  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    const key = (it.href || "").toUpperCase();
    if (!seen.has(key)) { uniq.push(it); seen.add(key); }
    if (uniq.length >= limit) break;
  }
  return uniq;
}

async function crawlOneUrl(browser, url, limit) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(url, { waitUntil: "networkidle2", timeout: 120_000 });
  // If a consent banner blocks content in your region, click it here.
  // try { await page.click('button:has-text("Accept")', { timeout: 3000 }); } catch {}

  await scrollUntilLoaded(page, limit);
  const items = await scrapeFreeProductCards(page, limit);
  await page.close();
  return items;
}

function loadTargets({ inFile, startUrl }) {
  // If you have a file from previous crawler: [{ title, href }]
  if (inFile && fs.existsSync(inFile)) {
    const raw = JSON.parse(fs.readFileSync(inFile, "utf-8"));
    const hrefs = Array.isArray(raw) ? raw.map(r => (typeof r === "string" ? r : r?.href)).filter(Boolean) : [];
    if (hrefs.length) return hrefs;
  }
  if (startUrl) return [startUrl];
  // fallback: apps hub
  return ["https://apps.microsoft.com/apps?hl=en-US&gl=US"];
}

async function main() {
  const inFile  = args.in ? path.resolve(args.in) : DEFAULT_IN;
  const outFile = args.out ? path.resolve(args.out) : DEFAULT_OUT;
  const startUrl = args.url;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const targets = loadTargets({ inFile, startUrl });
    if (!targets.length) throw new Error("No targets found (no --in or --url).");

    const all = [];
    for (const url of targets) {
      console.log(`Crawling: ${url}`);
      const items = await crawlOneUrl(browser, url, LIMIT);
      console.log(`  Found ${items.length} free apps`);
      all.push(...items);
      if (all.length >= LIMIT) break; // global cap
    }

    // Global dedupe by href
    const byHref = new Map();
    for (const it of all) {
      const key = (it.href || "").toUpperCase();
      if (!byHref.has(key)) byHref.set(key, it);
    }
    const final = Array.from(byHref.values()).slice(0, LIMIT);

    fs.writeFileSync(outFile, JSON.stringify(final, null, 2), "utf-8");
    console.log(`Saved ${final.length} items to ${outFile}`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
