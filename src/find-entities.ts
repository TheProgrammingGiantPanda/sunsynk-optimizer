import { findEntities } from './optimizer/homeassistant';
import { loadConfig } from './optimizer/config';

const search = process.argv[2] ?? 'zappi';
const config = loadConfig();

findEntities(config.haUrl, config.haToken, search).then(entities => {
  if (!entities.length) { console.log(`No entities found matching "${search}"`); return; }
  entities.forEach(e => console.log(`${e.entity_id} | ${e.state} | ${e.friendly_name}`));
}).catch(err => console.error(err.message));
