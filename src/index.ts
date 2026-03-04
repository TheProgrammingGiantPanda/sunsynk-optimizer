import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';

export interface ClientOptions {
  baseUrl?: string;
  authPath?: string;
}

export default class SunsyncClient {
  baseUrl: string;
  authPath: string;
  token: string | null;
  axios: AxiosInstance;
  getPublicKeyPath: string;
  private _username: string | null = null;
  private _password: string | null = null;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://api.sunsynk.net';
    this.authPath = options.authPath || '/oauth/token/new';
    this.getPublicKeyPath = '/anonymous/publicKey';
    this.token = null;
    this.axios = axios.create({ baseURL: this.baseUrl, timeout: 10000 });

    // Re-authenticate automatically on 401 — token may have expired after a long run.
    // Sets _retry on the original config to prevent infinite loops.
    this.axios.interceptors.response.use(
      res => res,
      async (err) => {
        const original = err.config;
        if (err.response?.status === 401 && !original._retry && this._username && this._password) {
          original._retry = true;
          console.log('[client] Token expired (401) — re-authenticating…');
          const newToken = await this.login(this._username, this._password);
          original.headers['Authorization'] = `Bearer ${newToken}`;
          return this.axios(original);
        }
        throw err;
      }
    );
  }

  private _authHeaders(token?: string) {
    const t = token || this.token;
    if (!t) return {};
    return { Authorization: `Bearer ${t}` };
  }

  async login(username: string, password: string): Promise<string> {
    if (!username || !password) {
      throw new Error('username/email and password required');
    }

    const nonce = Date.now();

    const publicKeyResult = await this.axios.get(this.getPublicKeyPath, {
      params: { source: 'sunsynk', nonce, sign: 'unused' }
    });

    if (!publicKeyResult.data?.data) {
      throw new Error(`Failed to get public key`);
    }

    const publicKey: string = publicKeyResult.data.data;
    const sign = crypto
      .createHash('md5')
      .update(`nonce=${nonce}&source=sunsynk${publicKey.substring(0, 10)}`)
      .digest('hex');

    const pemKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    const encodedPassword = crypto
      .publicEncrypt(
        { key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(password)
      )
      .toString('base64');

    const payload = {
      sign,
      nonce,
      username,
      password: encodedPassword,
      grant_type: 'password',
      client_id: 'csp-web',
      source: 'sunsynk'
    } as Record<string, unknown>;

    try {
      const res = await this.axios.post(this.authPath, payload, {
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json'
        }
      });
      const data = res.data || {};
      if ((data as any).success === false) {
        throw new Error(`API error ${(data as any).code}: ${(data as any).msg}`);
      }
      const token =
        (data as any).access_token ||
        (data as any).token ||
        (data as any).accessToken ||
        ((data as any).data && (data as any).data.access_token) ||
        ((data as any).data && (data as any).data.token) ||
        null;
      if (!token) {
        throw new Error(
          `No token found in response: ${JSON.stringify(data)}`
        );
      }
      this.token = token;
      this._username = username;
      this._password = password;
      return token;
    } catch (err: any) {
      if (err.response) {
        const msg = `Login failed: ${err.response.status} ${JSON.stringify(
          err.response.data
        )}`;
        const e = new Error(msg) as any;
        e.response = err.response;
        throw e;
      }
      throw err;
    }
  }

  async getPlants(): Promise<any[]> {
    if (!this.token)
      throw new Error('Authentication required: call login() first');

    const res = await this.axios.get('/api/v1/plants', {
      params: { lan: 'en', page: 1, limit: 100 },
      headers: this._authHeaders()
    });
    return res.data?.data?.infos ?? [];
  }

  async getPlant(plantId: string | number): Promise<any> {
    if (!this.token)
      throw new Error('Authentication required: call login() first');

    const res = await this.axios.get(`/api/v1/plant/${plantId}`, {
      params: { lan: 'en' },
      headers: this._authHeaders()
    });
    return res.data?.data ?? res.data;
  }

  async setMinCharge(
    plantId: string | number,
    minPricePence: number | string,
    sellThreshold?: number,   // undefined = don't touch; 0 = disable (set 9999); >0 = enable at this price
    options: { token?: string; limitSoc?: number } = {}
  ): Promise<any> {
    const token = options.token || this.token;
    if (!token)
      throw new Error('Authentication required: call login() first or pass { token }');

    // Fetch current plant data to preserve all existing settings
    const plantRes = await this.axios.get(`/api/v1/plant/${plantId}`, {
      params: { lan: 'en' },
      headers: this._authHeaders(token)
    });
    const plant = plantRes.data?.data ?? plantRes.data;

    const products: any[] = plant?.products ?? [];

    // Update ratesThreshold for direction=1 (Charge Battery — import price threshold).
    // Spread the existing product to preserve provider, regionId, limitSoc etc.
    const updatedProducts = products.map((p: any) =>
      p.direction === 1 ? { ...p, ratesThreshold: String(minPricePence) } : p
    );
    if (!products.some((p: any) => p.direction === 1)) {
      console.warn('[optimizer] direction=1 product not found in plant — charge threshold not set');
    }

    // Update direction=0 (Dis-Charge Battery): always write limitSoc to protect battery health;
    // also update ratesThreshold when export is configured.
    // 999p effectively disables selling (Agile never reaches that price); a real value enables it.
    const dir0Idx = updatedProducts.findIndex((p: any) => p.direction === 0);
    if (dir0Idx >= 0) {
      const limitSoc = options.limitSoc ?? 20;
      const dir0Updates: any = { limitSoc };
      if (sellThreshold !== undefined) {
        const sellThresholdStr = sellThreshold > 0 ? String(sellThreshold) : '999';
        dir0Updates.ratesThreshold = sellThresholdStr;
        console.log(`[optimizer] Sell threshold → ${sellThresholdStr}p, limitSoc=${limitSoc}% (direction=0)`);
      }
      updatedProducts[dir0Idx] = { ...updatedProducts[dir0Idx], ...dir0Updates };
    } else {
      console.warn('[optimizer] direction=0 product not found in plant — dis-charge settings not updated');
    }

    // Strip server-generated fields from charges
    const charges = (plant?.charges ?? []).map(({ price, type, startRange, endRange }: any) => ({
      price, type, startRange, endRange
    }));

    const payload = {
      id: String(plantId),
      currency: plant?.currency?.id ?? plant?.currency,
      invest: plant?.invest ?? 0,
      charges,
      products: updatedProducts
    };

    const productSummary = updatedProducts.map((p: any) =>
      `dir${p.direction}=${p.ratesThreshold}`).join(', ');
    console.log(`[optimizer] Sending products: ${productSummary}`);

    try {
      const res = await this.axios.post(
        `/api/v1/plant/${plantId}/income`,
        payload,
        { headers: { ...this._authHeaders(token), 'Content-Type': 'application/json' } }
      );
      console.log(`[optimizer] income API response: ${JSON.stringify(res.data)}`);
      return res.data;
    } catch (err: any) {
      if (err.response) {
        const msg = `setMinCharge failed: ${err.response.status} ${JSON.stringify(err.response.data)}`;
        const e = new Error(msg) as any;
        e.response = err.response;
        throw e;
      }
      throw err;
    }
  }

  async loginAndSetMinCharge(
    usernameOrEmail: string,
    password: string,
    plantId: string | number,
    minPricePence: number | string
  ): Promise<any> {
    await this.login(usernameOrEmail, password);
    return this.setMinCharge(plantId, minPricePence);
  }
}
