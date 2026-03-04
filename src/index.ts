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

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://api.sunsynk.net';
    this.authPath = options.authPath || '/oauth/token/new';
    this.getPublicKeyPath = '/anonymous/publicKey';
    this.token = null;
    this.axios = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
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
    options: { token?: string } = {}
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

    // Update ratesThreshold for direction=1 (import/buy rate threshold)
    const updatedProducts = products.map((p: any) =>
      p.direction === 1 ? { ...p, ratesThreshold: String(minPricePence) } : p
    );
    if (!products.some((p: any) => p.direction === 1)) {
      updatedProducts.push({ direction: 1, ratesThreshold: String(minPricePence) });
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

    try {
      const res = await this.axios.post(
        `/api/v1/plant/${plantId}/income`,
        payload,
        { headers: { ...this._authHeaders(token), 'Content-Type': 'application/json' } }
      );
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
