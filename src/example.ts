import SunsyncClient from './index';

async function run() {
  const client = new SunsyncClient();

  try {
    // Replace these with real credentials to test
    const token = await client.login(
      process.env.SUNSYNK_USER || '',
      process.env.SUNSYNK_PASS || ''
    );
    console.log('Got token:', token);

    // const result = await client.setMinCharge(0.12);
    // console.log('Set min charge result:', result);
  } catch (err: any) {
    console.error('Error:', err.message || err);
  }
}

run();
