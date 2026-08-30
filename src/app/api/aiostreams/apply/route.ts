import { NextResponse } from "next/server";
import type { Account } from "@/app/types/accounts";
import type { AddonData } from "@/app/types/addon";
import { getAddons, getAuth, pushAddonCollection } from "@/app/lib/stremio-client";

type ApplyItem = {
  account: Account;
  variant: string;
};

type ApplyPayload = {
  items: ApplyItem[];
};

type ApplyResult = {
  index: number;
  success: boolean;
  variant?: string;
  variantUrl?: string;
  addonName?: string;
  message: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeManifestUrl(input: string): string {
  let value = (input || "").trim();
  if (value.startsWith("stremio://")) {
    value = `https://${value.slice("stremio://".length)}`;
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AIOStreams URL must use http(s)");
  }

  return parsed.toString();
}

function isAIOStreams(addon: AddonData): boolean {
  const id = addon?.manifest?.id?.toLowerCase?.() || "";
  const name = addon?.manifest?.name?.toLowerCase?.() || "";
  if (id.includes("aiostreams") || name.includes("aiostreams")) return true;

  try {
    const parsed = new URL(normalizeManifestUrl(addon.transportUrl));
    return parsed.pathname.toLowerCase().includes("/stremio/") &&
      parsed.pathname.toLowerCase().endsWith("/manifest.json");
  } catch {
    return false;
  }
}

function findInstalledAIOStreams(addons: AddonData[], configuredUrl?: string): number {
  if (configuredUrl) {
    try {
      const normalizedConfigured = normalizeManifestUrl(configuredUrl);
      const exact = addons.findIndex((addon) => {
        try {
          return normalizeManifestUrl(addon.transportUrl) === normalizedConfigured;
        } catch {
          return false;
        }
      });
      if (exact >= 0) return exact;
    } catch {
      // Ignore stale/invalid stored URL and fall through to manifest identity.
    }
  }

  return addons.findIndex(isAIOStreams);
}

function buildVariantUrl(installedUrl: string, variant: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(variant)) {
    throw new Error(`Invalid variant name: ${variant}`);
  }

  const parsed = new URL(normalizeManifestUrl(installedUrl));
  parsed.searchParams.delete("v");

  let path = parsed.pathname;
  path = path.replace(/\/v\/[^/]+\/manifest\.json$/i, "/manifest.json");

  if (!/\/manifest\.json$/i.test(path)) {
    throw new Error("Installed AIOStreams URL is not a manifest URL");
  }

  path = path.replace(/\/manifest\.json$/i, "");
  parsed.pathname = `${path}/v/${encodeURIComponent(variant)}/manifest.json`;
  return parsed.toString();
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1000, 500), 8000);
    }
  }

  return Math.min(750 * 2 ** attempt, 6000);
}

async function fetchManifestWithRetry(url: string): Promise<AddonData["manifest"]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (response.ok) {
      const manifest = await response.json();
      if (!manifest || typeof manifest !== "object") {
        throw new Error("Variant returned an invalid manifest");
      }
      if (typeof manifest.id !== "string" || typeof manifest.name !== "string") {
        throw new Error("Variant manifest is missing id/name");
      }
      return manifest as AddonData["manifest"];
    }

    if (![429, 502, 503].includes(response.status) || attempt === 3) {
      throw new Error(`Manifest fetch failed: HTTP ${response.status}`);
    }

    await sleep(retryDelayMs(response, attempt));
  }

  throw new Error("Manifest fetch failed after retries");
}

async function applyVariant(
  item: ApplyItem,
  index: number,
  manifestCache: Map<string, Promise<AddonData["manifest"]>>
): Promise<ApplyResult> {
  try {
    const variant = (item.variant || "").trim().toLowerCase();
    if (!variant) throw new Error("Choose a variant first");

    const authKey = await getAuth(item.account);
    const addons = (await getAddons(authKey)) as AddonData[];
    const addonIndex = findInstalledAIOStreams(addons, item.account.aiostreams_variant_url);

    if (addonIndex < 0) {
      throw new Error("AIOStreams is not installed on this Stremio account");
    }

    const currentAddon = addons[addonIndex];
    const variantUrl = buildVariantUrl(currentAddon.transportUrl, variant);

    let manifestPromise = manifestCache.get(variantUrl);
    if (!manifestPromise) {
      manifestPromise = fetchManifestWithRetry(variantUrl);
      manifestCache.set(variantUrl, manifestPromise);
    }
    const freshManifest = await manifestPromise;

    const updatedAddons = [...addons];
    updatedAddons[addonIndex] = {
      ...currentAddon,
      transportUrl: variantUrl,
      manifest: freshManifest,
    };

    await pushAddonCollection(authKey, updatedAddons);

    return {
      index,
      success: true,
      variant,
      variantUrl,
      addonName: freshManifest.name,
      message: `Applied variant ${variant}`,
    };
  } catch (error) {
    return {
      index,
      success: false,
      message: error instanceof Error ? error.message : "Unknown variant apply error",
    };
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ApplyPayload;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { success: false, error: "No variant assignments supplied" },
        { status: 400 }
      );
    }

    const results: ApplyResult[] = [];
    const manifestCache = new Map<string, Promise<AddonData["manifest"]>>();

    for (const [index, item] of body.items.entries()) {
      results.push(await applyVariant(item, index, manifestCache));
      if (index < body.items.length - 1) await sleep(400);
    }

    return NextResponse.json({
      success: results.some((result) => result.success),
      allSuccessful: results.every((result) => result.success),
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown request error",
      },
      { status: 500 }
    );
  }
}
