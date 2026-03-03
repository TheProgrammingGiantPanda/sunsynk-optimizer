import SunsyncClient from './index';

async function run() {
  const client = new SunsyncClient();

  try {
    const token = await client.login(
      process.env.SUNSYNK_USER || '',
      process.env.SUNSYNK_PASS || ''
    );
    console.log('Got token:', token.substring(0, 20) + '...');

    const plants = await client.getPlants();
    console.log('Plants:', plants.map(p => `${p.id} - ${p.name}`));

    const plantId = plants[0].id;
    const result = await client.setMinCharge(plantId, 20);
    console.log('Set min charge result:', result);
  } catch (err: any) {
    console.error('Error:', err.message || err);
  }
}

run();
