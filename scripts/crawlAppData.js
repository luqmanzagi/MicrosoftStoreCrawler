// appCrawler.js (ESM) — product-card aware (square-card + price-badge inside shadow DOM)
// Usage examples:
//   node appCrawler.js --url "https://apps.microsoft.com/collections/..." --limit 50
//   node appCrawler.js --in "./results/collection_page_items.json" --limit 50
//   node appCrawler.js --out "./results/apps_free.json"
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
const DEFAULT_IN  = path.resolve("results", "collection_page_items.json"); // optional list of {href}
const DEFAULT_OUT = path.resolve("results", "apps_free.json");
const DEFAULT_URL = "https://apps.microsoft.com/collections/computed/apps/TopFree?hl=en-US&gl=NL";
const LIMIT = Number(args.limit || 50);

function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isFreeCollectionUrl(url) {
  try {
    const u = new URL(url);
    return /topfree|free[-_]?apps|gratis/i.test(`${u.pathname}${u.search}`);
  } catch {
    return /topfree|free[-_]?apps|gratis/i.test(String(url || ""));
  }
}

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

async function countProductCards(page) {
  return page.evaluate(() => {
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
}

async function clickLoadMoreButton(page) {
  return page.evaluate(() => {
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
    for (const n of walk()) {
      if (!n || n.nodeType !== 1) continue;
      const cls = (n.getAttribute("class") || "").toLowerCase();
      if (n.localName !== "wa-button" || !cls.includes("load-more-button")) continue;
      n.scrollIntoView({ block: "center", inline: "nearest" });
      try {
        n.click();
        return true;
      } catch {
        try {
          n.shadowRoot?.querySelector("button")?.click();
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  });
}

async function scrollUntilLoaded(page, wantCount = 50, { maxRounds = 80, idleMs = 1200 } = {}) {
  let lastCount = 0;
  let stable = 0;
  for (let round = 1; round <= maxRounds; round++) {
    await page.evaluate(() => {
      const step = Math.max(700, Math.floor(window.innerHeight * 0.95));
      for (let i = 0; i < 30; i++) window.scrollBy(0, step);
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(idleMs);

    const count = await countProductCards(page);
    if (count >= wantCount) break;

    const clicked = await clickLoadMoreButton(page);
    if (clicked) {
      console.log(`  Clicked load-more (${count} cards, want ${wantCount})`);
      const started = Date.now();
      while (Date.now() - started < 8000) {
        await sleep(500);
        if (await countProductCards(page) > count) break;
      }
      lastCount = await countProductCards(page);
      stable = 0;
      continue;
    }

    if (count <= lastCount) stable++;
    else { stable = 0; lastCount = count; }
    if (stable >= 3) break;
  }
}

async function scrapeFreeProductCards(page, limit = 50, { treatAllAsFree = false } = {}) {
  const items = await page.evaluate(({ limit, treatAllAsFree }) => {
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

    function isFreePrice(text) {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (!t) return false;
      if (/\b(free|gratis|gratuit|kostenlos|gratuito|grátis|gratuita)\b/i.test(t)) return true;
      if (/^(€|eur|usd|us\$|\$|£)?\s*0([.,]00)?$/i.test(t)) return true;
      return false;
    }

    function getPriceText(card) {
      const roots = [card.shadowRoot, card].filter(Boolean);
      for (const scope of roots) {
        const badge = scope.querySelector?.("price-badge");
        const candidates = [
          badge?.shadowRoot?.querySelector('[part="price-container"], .price-container'),
          badge?.querySelector?.('[part="price-container"], .price-container'),
          scope.querySelector?.('[part="price-container"], .price-container'),
        ];
        for (const el of candidates) {
          const t = (el?.textContent || "").replace(/\s+/g, " ").trim();
          if (t) return t;
        }
      }
      for (const n of walk(card.shadowRoot || card)) {
        if (n.nodeType !== 1) continue;
        const cls = `${n.getAttribute("class") || ""} ${n.getAttribute("part") || ""}`;
        if (!/price-container/.test(cls)) continue;
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
      return "";
    }

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

      const priceText = getPriceText(card);
      if (!treatAllAsFree && !isFreePrice(priceText)) continue;

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
  }, { limit, treatAllAsFree });

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

async function dismissConsent(page) {
  try {
    await page.evaluate(() => {
      const labels = /accept|agree|allow|accepteren|akkoord|reject|weigeren|only necessary/i;
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
      for (const n of walk()) {
        if (!n || n.nodeType !== 1) continue;
        const tag = n.localName;
        const role = n.getAttribute?.("role") || "";
        const text = (n.textContent || "").replace(/\s+/g, " ").trim();
        if ((tag === "button" || role === "button") && labels.test(text) && text.length < 48) {
          try { n.click(); } catch {}
          return;
        }
      }
    });
    await sleep(400);
  } catch {}
}

async function waitForProductCards(page, timeout = 30_000) {
  try {
    await page.waitForFunction(() => {
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
      for (const n of walk()) {
        if (n.nodeType === 1 && n.localName === "square-card") return true;
      }
      return false;
    }, { timeout });
  } catch {}
}

async function crawlOneUrl(browser, url, limit) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9,nl-NL;q=0.8" });
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await dismissConsent(page);
  await waitForProductCards(page);

  await scrollUntilLoaded(page, limit);
  const items = await scrapeFreeProductCards(page, limit, {
    treatAllAsFree: isFreeCollectionUrl(url),
  });
  await page.close();
  return items;
}

function loadTargets({ inFile, startUrl }) {
  if (startUrl) return [startUrl];
  if (inFile && fs.existsSync(inFile)) {
    const raw = JSON.parse(fs.readFileSync(inFile, "utf-8"));
    const hrefs = Array.isArray(raw) ? raw.map(r => (typeof r === "string" ? r : r?.href)).filter(Boolean) : [];
    if (hrefs.length) return hrefs;
  }
  return [DEFAULT_URL];
}

async function main() {
  const inArg = args.in && args.in !== true ? String(args.in) : "";
  const urlArg = args.url && args.url !== true ? String(args.url) : "";
  const startUrl = looksLikeUrl(urlArg) ? urlArg.trim() : (looksLikeUrl(inArg) ? inArg.trim() : "");
  const inFile = inArg && !looksLikeUrl(inArg) ? path.resolve(inArg) : (startUrl ? "" : DEFAULT_IN);
  const outFile = args.out ? path.resolve(args.out) : DEFAULT_OUT;

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
