import axios from 'axios';
import { withRetry } from './retry';

export interface PriceSlot {
  value_exc_vat: number;
  value_inc_vat: number;  // pence per kWh
  valid_from: string;     // ISO 8601
  valid_to: string;       // ISO 8601
  payment_method: string | null;
}

export async function getAgileRates(
  product: string,
  tariff: string
): Promise<PriceSlot[]> {
  const url = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/`;
  return withRetry(
    () => axios.get(url, { params: { page_size: 192 }, headers: { Accept: 'application/json' }, timeout: 15000 })
      .then(res => res.data?.results ?? []),
    { label: 'Octopus Agile rates' }
  );
}
