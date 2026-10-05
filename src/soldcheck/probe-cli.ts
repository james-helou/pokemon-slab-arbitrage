import { mkdir, writeFile } from 'node:fs/promises';
import { runProbeCli } from './probe.js';

// For James to run once by hand: npm run soldcheck:probe -- "Charizard ex 199 PSA 10"
// Exit 2 when blocked, 0 on 2xx, 1 on any other status or error.
process.exitCode = await runProbeCli(process.argv.slice(2).join(' '), {
  fetch, now: () => new Date(), print: (line) => console.log(line),
  mkdir: async (p) => { await mkdir(p, { recursive: true }); },
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
});
