export interface PtcgCard {
  id: string;
  name: string;
  number: string;
  set: { id: string; name: string; printedTotal: number | null };
}

interface PtcgPage {
  data: PtcgCard[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export async function* fetchAllCards(fetchFn: typeof fetch, apiKey?: string): AsyncGenerator<PtcgCard[]> {
  for (let page = 1; ; page++) {
    const url = `https://api.pokemontcg.io/v2/cards?page=${page}&pageSize=250&select=id,name,number,set`;
    const res = await fetchFn(url, { headers: apiKey ? { 'X-Api-Key': apiKey } : {} });
    if (!res.ok) throw new Error(`pokemontcg.io ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as PtcgPage;
    yield body.data;
    if (page * body.pageSize >= body.totalCount || body.data.length === 0) return;
  }
}
