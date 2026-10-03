import type { Log } from '../log.js';
import type { CompsSource, SourcedComp } from './comps-source.js';

export interface CompositePart {
  source: CompsSource;
  /** Best-effort part (e.g. browser agent): a failure is logged and skipped instead of failing the valuation. */
  optional?: boolean;
}

/**
 * Merges several comps sources (vendor, fixture, own DB, ...). Name is the part names joined with '+', which is
 * what valuations.comps_source and the alert footer show. A required part failing fails the whole fetch, so the
 * oracle never values on partial data. Comps are deduped by (kind, sourceRef), first part wins.
 */
export function compositeCompsSource(parts: CompositePart[], log: Log): CompsSource {
  if (parts.length === 0) throw new Error('compositeCompsSource needs at least one source');
  return {
    name: parts.map((p) => p.source.name).join('+'),
    async fetchComps(key) {
      const settled = await Promise.allSettled(parts.map((p) => p.source.fetchComps(key)));
      const seen = new Set<string>();
      const out: SourcedComp[] = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const r = settled[i]!;
        if (r.status === 'rejected') {
          if (!part.optional) throw r.reason;
          log('warn', 'optional comps source failed', {
            source: part.source.name, err: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
          continue;
        }
        for (const c of r.value) {
          const k = `${c.kind}|${c.sourceRef}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(c);
        }
      }
      return out;
    },
  };
}
