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

function normalizeManifestUrl(input: string): string {
  let url = (input || "").trim();
  if (!url) throw new Error("AIOStreams variant manifest URL is missing");

  if (url.startsWith("stremio://")) {
    url = `https://${url.slice("stremio://".length)}`;
  }

  if (url.endsWith("/configure")) {
    url = `${url.slice(0, -"/configure".length)}/manifest.json`;
  } else if (!url.endsWith("/manifest.json")) {
    url = `${url.replace(/\/$/, "")}/manifest.json`;
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Variant URL must use http(s)");
  }

  return parsed.toString();
}

function normalizeTransportUrl(input: string): string {
  try {
    return normalizeManifestUrl(input);
  } catch {
    return (input || "").trim();
  }
}

function hasAIOStreamsIdentity(addon: AddonData): boolean {
  const id = addon?.manifest?.id?.toLowerCase?.() || "";
  const name = addon?.manifest?.name?.toLowerCase?.() || "";
  return id.includes("aiostreams") || name.includes("aiostreams");
}

function sameOriginAndStremioPath(addon: AddonData, targetManifestUrl: string): boolean {
  try {
    const current = new URL(normalizeTransportUrl(addon.transportUrl));
    const target = new URL(targetManifestUrl);
    return (
      current.origin === target.origin &&
      current.pathname.includes("/stremio/") &&
      target.pathname.includes("/stremio/")
    );
  } catch {
    return false;
  }
}

function findInstalledAIOStreams(addons: AddonData[], targetManifestUrl: string): number {
  const exact = addons.findIndex(
    (addon) => normalizeTransportUrl(addon.transportUrl) === targetManifestUrl
  );
  if (exact >= 0) return exact;

  const identifiedSameOrigin = addons.findIndex(
    (addon) => hasAIOStreamsIdentity(addon) && sameOriginAndStremioPath(addon, targetManifestUrl)
  );
  if (identifiedSameOrigin >= 0) return identifiedSameOrigin;

  const identified = addons.findIndex(hasAIOStreamsIdentity);
  if (identified >= 0) return identified;

  // Fallback for installations with custom ADDON_NAME/ADDON_ID: an existing
  // /stremio/... manifest on the same AIOStreams origin is the best safe match.
  return addons.findIndex((addon) => sameOriginAndStremioPath(addon, targetManifestUrl));
}

async function fetchFreshManifest(manifestUrl: string): Promise<AddonData["manifest"]> {
  const response = await fetch(manifestUrl, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status}`);
  }

  const manifest = await response.json();
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Variant returned an invalid manifest");
  }
  if (typeof manifest.id !== "string" || typeof manifest.name !== "string") {
    throw new Error("Variant manifest is missing id/name");
  }

  return manifest as AddonData["manifest"];
}

async function refreshAccount(account: Account, index: number): Promise<RefreshResult> {
  try {
    const variantUrl = normalizeManifestUrl(account.aiostreams_variant_url || "");
    const freshManifest = await fetchFreshManifest(variantUrl);
    const authKey = await getAuth(account);
    const addons = (await getAddons(authKey)) as AddonData[];

    const addonIndex = findInstalledAIOStreams(addons, variantUrl);
    if (addonIndex < 0) {
      throw new Error(
        "AIOStreams is not installed on this account. Install the desired variant once, then run Detect/Refresh."
      );
    }

    const currentAddon = addons[addonIndex];
    const updatedAddons = [...addons];

    // Preserve flags, transportName and collection position, but replace the
    // transport URL and manifest exactly as a reinstall/refresh would do.
    updatedAddons[addonIndex] = {
      ...currentAddon,
      transportUrl: variantUrl,
      manifest: freshManifest,
    };

    await pushAddonCollection(authKey, updatedAddons);

    return {
      index,
      success: true,
      variantUrl,
      addonName: freshManifest.name,
      message: `Refreshed ${freshManifest.name} in place`,
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

    // Keep operations sequential to avoid hammering Stremio/AIOStreams and to
    // make per-account failures isolated and predictable.
    const results: RefreshResult[] = [];
    for (const [index, account] of body.accounts.entries()) {
      results.push(await refreshAccount(account, index));
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
