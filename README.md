# sunsync-mincharge (TypeScript)

TypeScript client to authenticate with `api.sunsync.net` and set the minimum charge price.

> Note: The real `api.sunsync.net` endpoints and payload shapes may differ. This module uses sensible defaults (`POST /auth/login` and `PUT /settings/min_charge`) and is configurable.

## Install

Install runtime dependency and dev tools for local development:

```bash
npm install
npm install --save-dev typescript ts-node @types/node
```

## Build

```bash
npm run build
```

## Usage (TypeScript)

```ts
import SunsyncClient from 'sunsync-mincharge';

(async () => {
  const client = new SunsyncClient({ baseUrl: 'https://api.sunsync.net' });

  try {
    const token = await client.login('user@example.com', 'password123');
    console.log('Got token:', token);

    const result = await client.setMinCharge(0.12);
    console.log('Set min charge result:', result);
  } catch (err) {
    console.error('Error:', err);
  }
})();
```

## Configuration options

When creating the client you can pass:

- `baseUrl` - default `https://api.sunsync.net`
- `authPath` - default `/auth/login`
- `minChargePath` - default `/settings/min_charge`

When calling `setMinCharge(minPrice, options)` you can pass:

- `token` - a token string if you don't want to call `login()` first
- `fieldName` - the JSON field name the API expects (default `min_price`)

## Example

Run the included example (replace with real credentials):

```bash
npm run example
```

## Notes

If the real Sunsync API uses different endpoints or expects different JSON shapes, pass custom paths and field names to the client constructor and methods. I can adapt this to match the official API if you provide its docs.