import { loadConfig } from '../lib/config.mjs';
import { WikiIndex } from '../lib/index.mjs';

const config = loadConfig({
  cwd: process.cwd(),
  env: process.env,
  base: {
    vaults: [{ name: 'vault', path: 'C:/git/vault', includeRaw: true }],
    indexDir: 'tests/.tmp-smoke-index',
    autoIndex: true
  }
});
console.log('vaults', config.vaults.map((v) => ({ name: v.name, path: v.path, exists: v.exists })));
const index = new WikiIndex(config.vaults[0], config);
const stats = await index.ensureFresh({});
console.log('stats', JSON.stringify(stats));
for (const query of ['индексы postgres', 'контекст агента', 'мост карелия', 'bsl диагностика', '1c mtp']) {
  const result = index.search({ query, corpus: 'wiki', limit: 5 });
  console.log('QUERY', query);
  for (const row of result.rows) console.log(' ', row.score.toFixed(2), row.path, '|', row.name);
}
const similar = index.similar({ path: '10-wiki/1c-postgres-indexes', limit: 5 });
console.log('SIMILAR', similar.rows.map((row) => row.path));
index.close();
