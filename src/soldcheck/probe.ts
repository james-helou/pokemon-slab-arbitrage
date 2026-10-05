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
  if (!q) throw new Error(USAGE);
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

const USAGE = 'usage: npm run soldcheck:probe -- "<query>" (query is required)';

/** Exit code for a finished probe: 2 blocked, 0 on 2xx, 1 on any other status. */
export function probeExitCode(r: Pick<ProbeResult, 'status' | 'blocked'>): number {
  if (r.blocked) return 2;
  return r.status >= 200 && r.status < 300 ? 0 : 1;
}

/** CLI wrapper: never throws, prints a one-line usage or error message instead of a stack trace. */
export async function runProbeCli(query: string, deps: ProbeDeps): Promise<number> {
  if (!query.trim()) {
    deps.print(USAGE);
    return 1;
  }
  try {
    return probeExitCode(await runProbe(query, deps));
  } catch (err) {
    deps.print(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
