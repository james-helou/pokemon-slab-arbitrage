import { load, type CheerioAPI } from 'cheerio';

/**
 * UNVERIFIED: the selectors below were written against hand-built fixtures that follow eBay's documented
 * sold-search markup (legacy `li.s-item` and newer `li.s-card`), not a saved real page. Before SOLD_CHECK=on,
 * run the Task 6 probe once, save the real page as a fixture, adjust this parser and bump to 'v1'.
 */
export const PARSER_VERSION = 'v0-unverified';

export interface ParsedSale {
  title: string;
  price: number;
  currency: 'USD';
  /** UTC midnight of the "Sold <date>" caption; null when no caption was found. */
  soldAt: Date | null;
  /** Struck-through original price or "Best offer accepted": the real sale price is unknown. */
  bestOfferAccepted: boolean;
  isLot: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
/** "Sold Oct 2, 2026" (M-D-Y). */
const SOLD_MDY = /Sold\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/;
/** "Sold 2 Oct 2026" (D-M-Y). */
const SOLD_DMY = /Sold\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/;
const USD_PRICE = /^(?:US\s*)?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
/** Multi-card titles. "x1" and "1x" stay single; "x2", "2x", "pair", "3 PSA 10s" are lots. */
const LOT = [
  /\b(lot|lots|bundle|set of \d+|\d+\s*(cards|slabs))\b/i,
  /\b(pair|duo|trio)\b/i,
  /\b([2-9]|[1-9]\d)\s*x\b/i,
  /\bx\s*([2-9]|[1-9]\d)\b/i,
  /\b\d+\s*(psa|cgc|bgs)\s*[\d.]*s\b/i,
];
const isLotTitle = (title: string) => LOT.some((re) => re.test(title));
const BEST_OFFER = /best\s*offer\s*accepted/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function utcDay(year: number, monthName: string, day: number): Date | null {
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls "Feb 31" into March; reject anything that did not round-trip.
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d;
}

function parseSoldAt(text: string): Date | null {
  const mdy = SOLD_MDY.exec(text);
  if (mdy) return utcDay(Number(mdy[3]), mdy[1]!, Number(mdy[2]));
  const dmy = SOLD_DMY.exec(text);
  if (dmy) return utcDay(Number(dmy[3]), dmy[2]!, Number(dmy[1]));
  return null;
}

function parsePrice(text: string): number | null {
  const t = clean(text);
  if (/\bto\b/i.test(t)) return null;
  const m = USD_PRICE.exec(t);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseItem(item: ReturnType<CheerioAPI>): ParsedSale | null {
  const titleEl = item.find('.s-item__title, .s-card__title').first().clone();
  titleEl.find('.LIGHT_HIGHLIGHT, .clipped').remove();
  const title = clean(titleEl.text()).replace(/^New Listing\s*/i, '');
  if (!title || /^shop on ebay$/i.test(title)) return null;

  const priceEl = item.find('.s-item__price, .s-card__price').first();
  const price = parsePrice(priceEl.text());
  if (price === null) return null;

  const struck = priceEl.is('[class*="STRIKETHROUGH" i], s, del') || priceEl.find('[class*="STRIKETHROUGH" i], s, del').length > 0;
  const itemText = clean(item.text());
  const caption = clean(item.find('.s-item__caption--signal, .s-item__caption, .s-card__caption').text());

  return {
    title,
    price,
    currency: 'USD',
    soldAt: parseSoldAt(caption) ?? parseSoldAt(itemText),
    bestOfferAccepted: struck || BEST_OFFER.test(itemText),
    isLot: isLotTitle(title),
  };
}

/** eBay item id from a result link, else the link without its query string, else null. */
function itemKey(item: ReturnType<CheerioAPI>): string | null {
  const href = item.find('a.s-item__link, a.su-link, a[href*="/itm/"]').first().attr('href')
    ?? item.find('a[href]').first().attr('href');
  if (!href) return null;
  const id = /\/itm\/(?:[^/?#]+\/)?(\d+)(?=[/?#]|$)/.exec(href);
  if (id) return `itm:${id[1]}`;
  return `url:${href.split(/[?#]/)[0]}`;
}

const ITEM = 'li.s-item, li.s-card';
/** eBay appends looser "Results matching fewer words" below the real results; everything after it is out of scope. */
const DIVIDER = '[class*="srp-river-answer"], li:not(.s-item):not(.s-card)';

/**
 * Pure: extracts USD single-price sold results, in page order, up to the "fewer words" divider. Placeholders,
 * price ranges and non-USD prices are skipped. Duplicates are dropped by item id, else URL, else title+price+date.
 */
export function parseSoldResults(html: string): ParsedSale[] {
  if (!html) return [];
  const $ = load(html);
  const out: ParsedSale[] = [];
  const seen = new Set<string>();
  for (const el of $(`${ITEM}, ${DIVIDER}`).toArray()) {
    const node = $(el);
    if (!node.is(ITEM)) {
      // A wrapper that holds result items is not the divider.
      if (node.find(ITEM).length === 0 && (node.is('[class*="srp-river-answer"]') || /fewer words/i.test(node.text()))) break;
      continue;
    }
    const sale = parseItem(node);
    if (!sale) continue;
    const key = itemKey(node) ?? `t:${sale.title}|${sale.price}|${sale.soldAt?.getTime() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sale);
  }
  return out;
}

const CHALLENGE = [
  /pardon our interruption/i, /verify you are a human/i, /checking your browser/i, /just a moment/i, /captcha/i,
];

/** True when the page has at least one real result item (a title that is not the "Shop on eBay" placeholder). */
function hasResultItems($: CheerioAPI): boolean {
  return $(ITEM).toArray().some((el) => {
    const t = clean($(el).find('.s-item__title, .s-card__title').first().text());
    return t.length > 0 && !/^shop on ebay$/i.test(t);
  });
}

/**
 * A block opens the 24 h circuit breaker, so it must be conservative: 403/429, or a page with no result items
 * whose <title> or visible body text (scripts, styles and noscript removed) reads like a challenge. Raw HTML is
 * never scanned: a normal results page can mention "recaptcha" in a script. An empty results page is no_results.
 */
export function detectBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429) return true;
  if (!html) return false;
  const $ = load(html);
  if (hasResultItems($)) return false;
  $('script, style, noscript, template').remove();
  const title = clean($('title').text());
  $('title').remove();
  const body = clean($.root().text());
  return CHALLENGE.some((re) => re.test(title) || re.test(body));
}
