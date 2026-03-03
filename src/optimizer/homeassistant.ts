import axios from 'axios';

function haClient(haUrl: string, haToken: string) {
  return axios.create({
    baseURL: `${haUrl}/api`,
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

/**
 * Returns the current state of a HA entity as a number.
 */
export async function getEntityState(
  haUrl: string,
  haToken: string,
  entityId: string
): Promise<number> {
  const res = await haClient(haUrl, haToken).get(`/states/${entityId}`);
  const val = parseFloat(res.data?.state);
  if (isNaN(val)) {
    throw new Error(
      `Entity ${entityId} has non-numeric state: "${res.data?.state}"`
    );
  }
  return val;
}

/**
 * Lists all entity IDs matching a search string — useful for discovering sensor names.
 */
export async function findEntities(
  haUrl: string,
  haToken: string,
  search: string
): Promise<{ entity_id: string; state: string; friendly_name: string }[]> {
  const res = await haClient(haUrl, haToken).get('/states');
  return (res.data as any[])
    .filter((e: any) => e.entity_id.includes(search))
    .map((e: any) => ({
      entity_id: e.entity_id,
      state: e.state,
      friendly_name: e.attributes?.friendly_name ?? '',
    }));
}
