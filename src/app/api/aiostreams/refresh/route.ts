import { NextResponse } from "next/server";
import type { Account } from "@/app/types/accounts";
import type { AddonData } from "@/app/types/addon";
import { getAddons, getAuth, pushAddonCollection } from "@/app/lib/stremio-client";

type RefreshPayload = {
  accounts: Account[];
};

type RefreshResult = {
  index: number;
  success: boolean;
  variantUrl?: string;
  addonName?: string;
  message: string;
};

type Manifest = AddonData["manifest"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeManifestUrl(input: string): string {
  let url = (input || "").trim();
  if (!url) throw new Error("AIOStreams manifest URL is missing");

  if (url.startsWith("stremio://")) {
    url = `https://${url.slice("stremio://".length)}`;
  }

  if (url.endsWith("/configure")) {
    url = `${url.slice(0, -"/configure".length)}/manifest.json`;
  } else if (!url.endsWith("/manifest.json") && !url.includes("/manifest.json?")) {
    url = `${url.replace(/\/$/, "")}/manifest.json`;
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Manifest URL must use http(s)");
  }

  return parsed.toString();
}

function normalizeForComparison(input?: string): string {
  if (!input) return "";
  try {
    const parsed = new URL(normalizeManifestUrl(input));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return input.trim();
  }
}

function getVariantSelector(input?: string): string | null {
  if (!input) return null;
  try {
    const parsed = new URL(normalizeManifestUrl(input));
    const pathMatch = parsed.pathname.match(/\/v\/([^/]+)\/manifest\.json$/i);
    if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

function hasAIOStreamsIdentity(addon: AddonData): boolean {
  const id = addon?.manifest?.id?.toLowerCase?.() || "";
  const name = addon?.manifest?.name?.toLowerCase?.() || "";
  return id.includes("aiostreams") || name.includes("aiostreams");
}

function looksLikeAIOStreamsTransport(addon: AddonData): boolean {
  try {
    const parsed = new URL(normalizeManifestUrl(addon.transportUrl));
    const path = parsed.pathname.toLowerCase();
    return path.includes("/stremio/") && path.endsWith("/manifest.json");
  } catch {
    return false;
  }
}

function findInstalledAIOStreams(addons: AddonData[], preferredUrl?: string): number {
  const preferred = normalizeForComparison(preferredUrl);

  const candidates = addons
    .map((addon, index) => ({ addon, index }))
    .filter(({ addon }) => hasAIOStreamsIdentity(addon));

  // Support custom ADDON_NAME / ADDON_ID. Only add URL-shaped fallbacks when
  // identity matching found nothing, to avoid mistaking unrelated Stremio addons.
  const effectiveCandidates = candidates.length > 0
    ? candidates
    : addons
        .map((addon, index) => ({ addon, index }))
        .filter(({ addon }) => looksLikeAIOStreamsTransport(addon));

  if (effectiveCandidates.length === 0) return -1;

  // Variants are distinct addon installs. If exactly one /v/... or ?v= entry is
  // present, prefer it over the base config. This avoids accidentally picking
  // /stremio/u/main/manifest.json just because it appears first in the collection.
  const variantCandidates = effectiveCandidates.filter(({ addon }) =>
    Boolean(getVariantSelector(addon.transportUrl))
  );

  if (variantCandidates.length === 1) {
    return variantCandidates[0].index;
  }

  // With multiple variants installed, use the stored URL only as an exact match.
  if (variantCandidates.length > 1 && preferred) {
    const exactVariant = variantCandidates.find(
      ({ addon }) => normalizeForComparison(addon.transportUrl) === preferred
    );
    if (exactVariant) return exactVariant.index;
  }

  if (variantCandidates.length > 1) {
    throw new Error(
      "Multiple AIOStreams variants are installed on this account. Detect/select the intended one before refreshing."
    );
  }

  // No variant URL exists. A single AIOStreams entry is safely the base config.
  if (effectiveCandidates.length === 1) {
    return effectiveCandidates[0].index;
  }

  // If several base-looking entries exist, only accept an exact stored URL.
  if (preferred) {
    const exact = effectiveCandidates.find(
      ({ addon }) => normalizeForComparison(addon.transportUrl) === preferred
    );
    if (exact) return exact.index;
  }

  throw new Error(
    "Multiple AIOStreams installs were found and the intended one is ambiguous."
  );
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1000, 500), 10000);
    }
  }

  return [1000, 2000, 4000, 7000][attempt] ?? 7000;
}

async function fetchFreshManifest(manifestUrl: string): Promise<Manifest> {
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(manifestUrl, {
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
        throw new Error("AIOStreams returned an invalid manifest");
      }
      if (typeof manifest.id !== "string" || typeof manifest.name !== "string") {
        throw new Error("AIOStreams manifest is missing id/name");
      }
      return manifest as Manifest;
    }

    const retryable = response.status === 429 || response.status === 502 || response.status === 503;
    if (!retryable || attempt === maxAttempts - 1) {
      throw new Error(`Manifest fetch failed: HTTP ${response.status}`);
    }

    await sleep(retryDelayMs(response, attempt));
  }

  throw new Error("Manifest fetch failed after retries");
}

async function refreshAccount(
  account: Account,
  index: number,
  manifestCache: Map<string, Promise<Manifest>>
): Promise<RefreshResult> {
  try {
    const authKey = await getAuth(account);
    const addons = (await getAddons(authKey)) as AddonData[];
    const addonIndex = findInstalledAIOStreams(addons, account.aiostreams_variant_url);

    if (addonIndex < 0) {
      throw new Error(
        "AIOStreams is not installed on this account. Install the desired variant once, then run Detect/Refresh."
      );
    }

    const currentAddon = addons[addonIndex];
    const installedUrl = normalizeManifestUrl(currentAddon.transportUrl);

    // Critical safety rule: refresh always follows the transportUrl CURRENTLY
    // installed in Stremio. The stored/user-entered URL is only a selection hint
    // when several AIOStreams installs exist; it is never written into the account.
    let manifestPromise = manifestCache.get(installedUrl);
    if (!manifestPromise) {
      manifestPromise = fetchFreshManifest(installedUrl);
      manifestCache.set(installedUrl, manifestPromise);
    }
    const freshManifest = await manifestPromise;

    const updatedAddons = [...addons];
    updatedAddons[addonIndex] = {
      ...currentAddon,
      // Preserve transportUrl EXACTLY. Only the manifest is refreshed.
      manifest: freshManifest,
    };

    await pushAddonCollection(authKey, updatedAddons);

    const selector = getVariantSelector(installedUrl);
    return {
      index,
      success: true,
      variantUrl: installedUrl,
      addonName: freshManifest.name,
      message: selector
        ? `Refreshed AIOStreams variant ${selector} in place`
        : `Refreshed AIOStreams base config in place`,
    };
  } catch (error) {
    return {
      index,
      success: false,
      message: error instanceof Error ? error.message : "Unknown refresh error",
    };
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RefreshPayload;
    if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
      return NextResponse.json(
        { success: false, error: "No accounts supplied" },
        { status: 400 }
      );
    }

    const results: RefreshResult[] = [];
    const manifestCache = new Map<string, Promise<Manifest>>();

    // Sequential account writes isolate failures. A small gap also reduces the
    // chance of hitting AIOStreams/Stremio rate limits during bulk operations.
    for (const [index, account] of body.accounts.entries()) {
      results.push(await refreshAccount(account, index, manifestCache));
      if (index < body.accounts.length - 1) await sleep(400);
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
