const NUVIO_URL = "https://api.nuvio.tv";
const NUVIO_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI";

export type NuvioProfile = {
  id: string;
  profile_index: number;
  name: string;
  uses_primary_addons?: boolean;
};

export type NuvioAddon = {
  id?: string;
  profile_id: number;
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
};

type RequestOptions = RequestInit & { token?: string };

async function nuvioFetch(path: string, options: RequestOptions = {}) {
  const { token, ...init } = options;
  const response = await fetch(`${NUVIO_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: NUVIO_ANON_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!response.ok) {
    const message = body?.message || body?.error_description || body?.error || `Nuvio HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}

export async function nuvioLogin(email: string, password: string) {
  return nuvioFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function nuvioGetProfiles(token: string): Promise<NuvioProfile[]> {
  return nuvioFetch("/rest/v1/rpc/sync_pull_profiles", {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

export async function nuvioGetAddons(token: string, profileId: number): Promise<NuvioAddon[]> {
  return nuvioFetch(`/rest/v1/addons?select=*&profile_id=eq.${profileId}&order=sort_order`, { token });
}

export async function nuvioPushAddons(
  token: string,
  profileId: number,
  addons: Array<Pick<NuvioAddon, "url" | "name" | "enabled" | "sort_order">>
) {
  await nuvioFetch("/rest/v1/rpc/sync_push_addons", {
    method: "POST",
    token,
    body: JSON.stringify({ p_profile_id: profileId, p_addons: addons }),
  });
}
