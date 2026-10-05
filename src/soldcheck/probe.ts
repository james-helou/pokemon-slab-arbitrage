import { ebaySoldSearchUrl } from '../discord/check-links.js';
import { detectBlocked, parseSoldResults, PARSER_VERSION } from './parse.js';
import { fetchSoldPage } from './sold-check.js';

export interface ProbeDeps {
  fetch: typeof fetch;
  now: () => Date;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  print: (line: string) => void;
}

export interface ProbeResult {
  path: string;
  status: number;
  blocked: boolean;
  saleCount: number;
}

const OUT_DIR = 'tmp';

/**
 * One real fetch through the sold check's own request, for verifying the v0 parser against a live page. Saves the raw
 * HTML (git-ignored tmp/) so it can become a real fixture. No DB, no retry, never writes sold_checks.
 */
export async function runProbe(query: string, deps: ProbeDeps): Promise<ProbeResult> {
  const q = query.trim();
  if (!q) throw new Error('usage: npm run soldcheck:probe -- "<query>" (query is required)');
  const url = ebaySoldSearchUrl(q);
  deps.print(`GET ${url}`);
  const { status, html } = await fetchSoldPage(deps.fetch, url);
  const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = `${OUT_DIR}/soldcheck-${stamp}.html`;
  await deps.mkdir(OUT_DIR);
  await deps.writeFile(path, html);
  const blocked = detectBlocked(html, status);
  const sales = parseSoldResults(html);
  deps.print(`status ${status}, ${html.length} bytes, saved ${path}`);
  deps.print(`blocked: ${blocked ? 'YES' : 'no'}`);
  deps.print(`${sales.length} parsed sales (parser ${PARSER_VERSION}):`);
  for (const s of sales) {
    const flags = [s.isLot ? 'lot' : '', s.bestOfferAccepted ? 'best offer' : ''].filter(Boolean).join(', ');
    deps.print(`- $${s.price.toFixed(2)} | ${s.soldAt?.toISOString().slice(0, 10) ?? 'no date'} | ${s.title}${flags ? ` [${flags}]` : ''}`);
  }
  return { path, status, blocked, saleCount: sales.length };
}
