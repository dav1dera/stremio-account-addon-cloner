import { NextResponse } from "next/server";

type DiscoveryPayload = {
  manifestUrl?: string;
  configPassword?: string;
  operatorUsername?: string;
  operatorPassword?: string;
};

type Variant = {
  id: string;
  name?: string;
  enabled?: boolean;
};

type AIOStreamsApiResponse = {
  success?: boolean;
  error?: { message?: string };
  detail?: string;
  data?: {
    userData?: {
      variants?: Variant[];
      [key: string]: unknown;
    };
    profiles?: Array<{
      id: string;
      uuid: string;
      label: string;
      alias: string | null;
      needsRelink?: boolean;
    }>;
    uuid?: string;
    password?: string;
    encryptedPassword?: string;
    [key: string]: unknown;
  };
};

type ConfigCredentials = {
  identifier: string;
  password: string;
  mode: "alias" | "uuid" | "profile";
};

function normalizeManifestUrl(input: string): URL {
  let value = (input || "").trim();
  if (!value) throw new Error("AIOStreams manifest URL is missing");

  if (value.startsWith("stremio://")) {
    value = `https://${value.slice("stremio://".length)}`;
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AIOStreams URL must use http(s)");
  }
  if (!parsed.pathname.toLowerCase().includes("/stremio/")) {
    throw new Error("The supplied URL does not look like an AIOStreams manifest URL");
  }

  return parsed;
}

function parseManifestIdentity(manifestUrl: URL) {
  const parts = manifestUrl.pathname.split("/").filter(Boolean);
  const stremioIndex = parts.findIndex((part) => part.toLowerCase() === "stremio");
  if (stremioIndex < 0) throw new Error("Could not parse AIOStreams manifest URL");

  if (parts[stremioIndex + 1]?.toLowerCase() === "u") {
    const alias = parts[stremioIndex + 2];
    if (!alias) throw new Error("AIOStreams alias is missing from the manifest URL");
    return { mode: "alias" as const, identifier: decodeURIComponent(alias) };
  }

  const uuid = parts[stremioIndex + 1];
  const urlPassword = parts[stremioIndex + 2];
  if (!uuid || !urlPassword) {
    throw new Error("Could not extract AIOStreams configuration credentials from the manifest URL");
  }

  return {
    mode: "uuid" as const,
    identifier: decodeURIComponent(uuid),
    urlPassword: decodeURIComponent(urlPassword),
  };
}

function basicAuth(identifier: string, password: string): string {
  return `Basic ${Buffer.from(`${identifier}:${password}`, "utf8").toString("base64")}`;
}

async function parseJson(response: Response): Promise<AIOStreamsApiResponse | null> {
  try {
    return (await response.json()) as AIOStreamsApiResponse;
  } catch {
    return null;
  }
}

function apiError(json: AIOStreamsApiResponse | null, status: number, fallback: string) {
  return json?.error?.message || json?.detail || `${fallback} (HTTP ${status})`;
}

async function resolveAliasThroughProfile(
  origin: string,
  alias: string,
  operatorUsername: string,
  operatorPassword: string
): Promise<ConfigCredentials> {
  const loginResponse = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    cache: "no-store",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: operatorUsername, password: operatorPassword }),
    signal: AbortSignal.timeout(15000),
  });
  const loginJson = await parseJson(loginResponse);
  if (!loginResponse.ok || !loginJson?.success) {
    throw new Error(
      `AIOStreams operator login failed: ${apiError(loginJson, loginResponse.status, "login failed")}`
    );
  }

  const setCookie = loginResponse.headers.get("set-cookie");
  const sessionCookie = setCookie?.split(";")[0];
  if (!sessionCookie) {
    throw new Error("AIOStreams operator login succeeded but no session cookie was returned");
  }

  const profilesResponse = await fetch(`${origin}/api/v1/profiles`, {
    method: "GET",
    cache: "no-store",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Cookie: sessionCookie,
    },
    signal: AbortSignal.timeout(15000),
  });
  const profilesJson = await parseJson(profilesResponse);
  if (!profilesResponse.ok || !profilesJson?.success) {
    throw new Error(
      `Could not read AIOStreams saved profiles: ${apiError(profilesJson, profilesResponse.status, "profile lookup failed")}`
    );
  }

  const profiles = profilesJson.data?.profiles || [];
  const profile = profiles.find(
    (item) => item.alias?.trim().toLowerCase() === alias.trim().toLowerCase()
  );
  if (!profile) {
    throw new Error(
      `No saved AIOStreams profile uses share alias "${alias}" for operator "${operatorUsername}"`
    );
  }
  if (profile.needsRelink) {
    throw new Error(`Saved AIOStreams profile "${profile.label}" needs to be relinked before it can be opened`);
  }

  const openResponse = await fetch(`${origin}/api/v1/profiles/${encodeURIComponent(profile.id)}/open`, {
    method: "POST",
    cache: "no-store",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Cookie: sessionCookie,
    },
    signal: AbortSignal.timeout(15000),
  });
  const openJson = await parseJson(openResponse);
  if (!openResponse.ok || !openJson?.success) {
    throw new Error(
      `Could not open AIOStreams profile "${profile.label}": ${apiError(openJson, openResponse.status, "profile open failed")}`
    );
  }

  const uuid = typeof openJson.data?.uuid === "string" ? openJson.data.uuid : "";
  const password = typeof openJson.data?.password === "string" ? openJson.data.password : "";
  if (!uuid || !password) {
    throw new Error(`AIOStreams profile "${profile.label}" did not return configuration credentials`);
  }

  return { identifier: uuid, password, mode: "profile" };
}

async function fetchUserData(origin: string, credentials: ConfigCredentials) {
  const response = await fetch(`${origin}/api/v1/user`, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(credentials.identifier, credentials.password),
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(15000),
  });

  const json = await parseJson(response);
  if (!response.ok || !json?.success) {
    throw new Error(
      `AIOStreams configuration API: ${apiError(json, response.status, "configuration lookup failed")}`
    );
  }

  return json.data?.userData;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DiscoveryPayload;
    const manifestUrl = normalizeManifestUrl(body.manifestUrl || "");
    const identity = parseManifestIdentity(manifestUrl);

    let credentials: ConfigCredentials;
    if (identity.mode === "uuid") {
      credentials = {
        identifier: identity.identifier,
        password: body.configPassword?.trim() || identity.urlPassword,
        mode: "uuid",
      };
    } else if (body.configPassword?.trim()) {
      credentials = {
        identifier: identity.identifier,
        password: body.configPassword.trim(),
        mode: "alias",
      };
    } else if (body.operatorUsername?.trim() && body.operatorPassword) {
      credentials = await resolveAliasThroughProfile(
        manifestUrl.origin,
        identity.identifier,
        body.operatorUsername.trim(),
        body.operatorPassword
      );
    } else {
      throw new Error(
        `Alias "${identity.identifier}" detected. Enter the alias configuration password, or use operator login when local password login is enabled.`
      );
    }

    const userData = await fetchUserData(manifestUrl.origin, credentials);
    if (!userData || typeof userData !== "object") {
      throw new Error("AIOStreams returned no configuration data");
    }

    const rawVariants = Array.isArray(userData.variants) ? userData.variants : [];
    const variants = rawVariants
      .filter(
        (variant) =>
          variant &&
          typeof variant.id === "string" &&
          /^[a-z0-9][a-z0-9_-]{0,31}$/.test(variant.id) &&
          variant.enabled !== false
      )
      .map((variant) => ({
        id: variant.id,
        name:
          typeof variant.name === "string" && variant.name.trim()
            ? variant.name.trim()
            : undefined,
      }));

    return NextResponse.json({
      success: true,
      variants,
      source: {
        origin: manifestUrl.origin,
        identifier: credentials.identifier,
        mode: credentials.mode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown variant discovery error",
      },
      { status: 400 }
    );
  }
}
