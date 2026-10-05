import { mkdir, writeFile } from 'node:fs/promises';
import { runProbe } from './probe.js';

// For James to run once by hand: npm run soldcheck:probe -- "Charizard ex 199 PSA 10"
const r = await runProbe(process.argv.slice(2).join(' '), {
  fetch, now: () => new Date(), print: (line) => console.log(line),
  mkdir: async (p) => { await mkdir(p, { recursive: true }); },
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
});
process.exitCode = r.blocked ? 2 : 0;
