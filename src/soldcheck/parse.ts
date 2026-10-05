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
const SOLD_DATE = /Sold\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/;
const USD_PRICE = /^(?:US\s*)?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
const LOT = /\b(lot|lots|bundle|set of \d+|\d+\s*(cards|slabs))\b/i;
const BEST_OFFER = /best\s*offer\s*accepted/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function parseSoldAt(text: string): Date | null {
  const m = SOLD_DATE.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d;
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
    isLot: LOT.test(title),
  };
}

/** Pure: extracts USD single-price sold results. Placeholders, price ranges and non-USD prices are skipped. */
export function parseSoldResults(html: string): ParsedSale[] {
  if (!html) return [];
  const $ = load(html);
  const out: ParsedSale[] = [];
  $('li.s-item, li.s-card').each((_, el) => {
    const sale = parseItem($(el));
    if (sale) out.push(sale);
  });
  return out;
}

const CHALLENGE = [/pardon our interruption/i, /verify you are a human/i, /captcha/i, /checking your browser/i];

/** A block opens the 24 h circuit breaker: 403/429 or a challenge/CAPTCHA page. */
export function detectBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429) return true;
  return CHALLENGE.some((re) => re.test(html));
}
