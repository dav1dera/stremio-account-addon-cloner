import { NextResponse } from "next/server";

type DiscoveryPayload = {
  manifestUrl?: string;
  configPassword?: string;
};

type Variant = {
  id: string;
  name?: string;
  enabled?: boolean;
};

type AIOStreamsApiResponse = {
  success?: boolean;
  error?: {
    message?: string;
  };
  detail?: string;
  data?: {
    userData?: {
      variants?: Variant[];
      [key: string]: unknown;
    };
  };
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

function extractConfigCredentials(
  manifestUrl: URL,
  suppliedPassword?: string
): { identifier: string; password: string; mode: "alias" | "uuid" } {
  const parts = manifestUrl.pathname.split("/").filter(Boolean);
  const stremioIndex = parts.findIndex((part) => part.toLowerCase() === "stremio");
  if (stremioIndex < 0) throw new Error("Could not parse AIOStreams manifest URL");

  // Alias form: /stremio/u/<alias>/manifest.json or /stremio/u/<alias>/v/<id>/manifest.json
  if (parts[stremioIndex + 1]?.toLowerCase() === "u") {
    const alias = parts[stremioIndex + 2];
    if (!alias) throw new Error("AIOStreams alias is missing from the manifest URL");

    const password = (suppliedPassword || "").trim();
    if (!password) {
      throw new Error(
        `This AIOStreams install uses alias "${decodeURIComponent(alias)}". Enter the configuration password once to load variants automatically.`
      );
    }

    return {
      identifier: decodeURIComponent(alias),
      password,
      mode: "alias",
    };
  }

  // Full form: /stremio/<uuid>/<password>/manifest.json (variant suffix may follow)
  const uuid = parts[stremioIndex + 1];
  const urlPassword = parts[stremioIndex + 2];
  if (!uuid || !urlPassword) {
    throw new Error("Could not extract AIOStreams configuration credentials from the manifest URL");
  }

  return {
    identifier: decodeURIComponent(uuid),
    password: suppliedPassword?.trim() || decodeURIComponent(urlPassword),
    mode: "uuid",
  };
}

function basicAuth(identifier: string, password: string): string {
  return `Basic ${Buffer.from(`${identifier}:${password}`, "utf8").toString("base64")}`;
}

async function fetchUserData(origin: string, identifier: string, password: string) {
  const response = await fetch(`${origin}/api/v1/user`, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(identifier, password),
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(15000),
  });

  let json: AIOStreamsApiResponse | null = null;
  try {
    json = (await response.json()) as AIOStreamsApiResponse;
  } catch {
    // handled below
  }

  if (!response.ok || !json?.success) {
    const detail = json?.error?.message || json?.detail;
    throw new Error(
      detail
        ? `AIOStreams configuration API: ${detail}`
        : `AIOStreams configuration API returned HTTP ${response.status}`
    );
  }

  return json.data?.userData;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DiscoveryPayload;
    const manifestUrl = normalizeManifestUrl(body.manifestUrl || "");
    const credentials = extractConfigCredentials(manifestUrl, body.configPassword);
    const userData = await fetchUserData(
      manifestUrl.origin,
      credentials.identifier,
      credentials.password
    );

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
