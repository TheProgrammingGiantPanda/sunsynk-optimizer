import axios, { AxiosInstance } from 'axios';
import JSEncrypt from 'jsencrypt';
import crypto from 'crypto';

export interface ClientOptions {
  baseUrl?: string;
  authPath?: string;
  minChargePath?: string;
}

export default class SunsyncClient {
  baseUrl: string;
  authPath: string;
  minChargePath: string;
  token: string | null;
  axios: AxiosInstance;
  getPublicKeyPath: string;
  private _nonce: any;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://api.sunsynk.net';
    this.authPath = options.authPath || '/oauth/token/new';
    this.getPublicKeyPath = '/anonymous/publicKey';
    this.minChargePath = options.minChargePath || '/settings/min_charge';
    this.token = null;
    this.axios = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
    this.axios.interceptors.request.use((request) => {
      console.log('Starting Request', JSON.stringify(request, null, 2));
      return request;
    });
    // this.axios.interceptors.response.use((response) => {
    //   console.log('Response:', JSON.stringify(response, null, 2));
    //   return response;
    // });
  }

  private _authHeaders(token?: string) {
    const t = token || this.token;
    if (!t) return {};
    return { Authorization: `Bearer ${t}` };
  }

  get nonce(): string {
    this._nonce = this._nonce || Date.now().toString();
    return this._nonce;
  }
  async login(username: string, password: string): Promise<string> {
    if (!username || !password) {
      throw new Error('username/email and password required');
    }

    const hash = crypto
      .createHash('md5')
      .update(`nonce=${this.nonce}&source=sunsynkPOWER_VIEW`)
      .digest('hex');

    const publicKeyReuslt = await this.axios.get(this.getPublicKeyPath, {
      params: {
        source: 'sunsynk',
        nonce: this.nonce,
        sign: hash
      }
    });

    if (!publicKeyReuslt.status || publicKeyReuslt.status !== 200) {
      throw new Error(`Failed to get public key: ${publicKeyReuslt.status}`);
    }

    const encrypt = new JSEncrypt();
    encrypt.setKey(publicKeyReuslt.data.data);

    const encodedPassword = encrypt.encrypt(password);
    if (!encodedPassword) {
      throw new Error('Password encryption failed');
    }
    const payload = {
      areaCode: 'sunsynk',
      client_id: 'csp-web',
      grant_type: 'password',
      password: encodedPassword,
      source: 'sunsynk',
      username: username
    } as Record<string, unknown>;

    try {
      const res = await this.axios.post(this.authPath, payload, {
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json'
        }
      });
      const data = res.data || {};
      const token =
        (data as any).access_token ||
        (data as any).token ||
        (data as any).accessToken ||
        ((data as any).data && (data as any).data.access_token) ||
        ((data as any).data && (data as any).data.token) ||
        null;
      if (!token) {
        throw new Error(
          'Login succeeded but no token found in response. Inspect response structure.'
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

  async setMinCharge(
    minPrice: number | string,
    options: { token?: string; fieldName?: string } = {}
  ): Promise<any> {
    if (typeof minPrice !== 'number' && typeof minPrice !== 'string') {
      throw new Error('minPrice must be a number or numeric string');
    }

    const token = options.token || this.token;
    if (!token)
      throw new Error(
        'Authentication required: call login() first or pass { token }'
      );

    const fieldName = options.fieldName || 'min_price';
    const payload: Record<string, unknown> = { [fieldName]: minPrice };

    try {
      const res = await this.axios.put(this.minChargePath, payload, {
        headers: this._authHeaders(token)
      });
      return res.data;
    } catch (err: any) {
      if (err.response) {
        const msg = `setMinCharge failed: ${
          err.response.status
        } ${JSON.stringify(err.response.data)}`;
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
    minPrice: number | string,
    options: { token?: string; fieldName?: string } = {}
  ): Promise<any> {
    await this.login(usernameOrEmail, password);
    return this.setMinCharge(minPrice, options);
  }
}
