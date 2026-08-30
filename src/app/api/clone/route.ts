import { NextResponse } from "next/server";
import type { Account } from "@/app/types/accounts";
import { pushAddonCollection, getAuth, getAddons } from "@/app/lib/stremio-client";
import type { AddonData } from "@/app/types/addon";
import { handleAddon } from "@/app/services/addonHandlers";
import { CloneResponse } from "@/app/types/apiResponse";

type ClonePayload = {
  primary: Account;
  clones: Account[];
  addons: AddonData[];
};

function normalizeUrl(value?: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

/**
 * Detect AIOStreams without relying on generic /stremio/... URL shapes.
 *
 * AIOmetadata and other addons can use very similar per-user manifest URLs, so
 * URL-path heuristics can misclassify them as AIOStreams and make cloning skip
 * them. Only treat an addon as AIOStreams when we have an exact configured
 * variant URL or the manifest explicitly identifies AIOStreams.
 */
function isAIOStreamsAddon(addon: AddonData, configuredVariantUrl?: string): boolean {
  const transportUrl = normalizeUrl(addon?.transportUrl);
  const configuredUrl = normalizeUrl(configuredVariantUrl);

  if (configuredUrl && transportUrl === configuredUrl) {
    return true;
  }

  const id = addon?.manifest?.id?.toLowerCase?.() || "";
  const name = addon?.manifest?.name?.toLowerCase?.() || "";

  return id.includes("aiostreams") || name.includes("aiostreams");
}

async function cloneAddonForAccount(addon: AddonData, account: Account): Promise<AddonData> {
  let currentAddon: AddonData = { ...addon };

  if (account.is_debrid_override && addon.manifest.id) {
    currentAddon = await handleAddon(addon, account);
  }

  return currentAddon;
}

export async function POST(req: Request) {
  const { primary, clones, addons }: ClonePayload = await req.json();

  try {
    let primaryAddons: AddonData[] = [];

    // Use user-selected addons if provided.
    if (addons.length > 0) {
      primaryAddons = addons;
    } else {
      try {
        const auth = await getAuth(primary);
        primaryAddons = await getAddons(auth);
      } catch (err) {
        if (err instanceof Error) {
          throw new Error(`Primary Account: ${err.message}`);
        }
      }
    }

    const clonedAddons: Record<string, AddonData[]> = {};

    for (const [index, acc] of clones.entries()) {
      try {
        const cloneAuth = await getAuth(acc);
        const existingAddons = (await getAddons(cloneAuth)) as AddonData[];

        // AIOStreams is special: every target account can have its own variant.
        // Never copy the Primary account's AIOStreams entry over a target.
        const targetAIOStreams = existingAddons.filter((addon) =>
          isAIOStreamsAddon(addon, acc.aiostreams_variant_url)
        );
        const targetAIOStreamsIndex = existingAddons.findIndex((addon) =>
          isAIOStreamsAddon(addon, acc.aiostreams_variant_url)
        );

        if (acc.clone_mode === "append") {
          // Append keeps the target collection as-is, including its AIOStreams variant.
          clonedAddons[cloneAuth] = [...existingAddons];

          for (const addon of primaryAddons) {
            // Never append the Primary AIOStreams variant; the target's installed
            // variant remains untouched. All other addons, including AIOmetadata,
            // are cloned normally.
            if (isAIOStreamsAddon(addon, primary.aiostreams_variant_url)) {
              continue;
            }

            // Skip Cinemeta in append mode, preserving upstream behavior.
            if (addon.manifest.id.includes("cinemeta")) {
              continue;
            }

            clonedAddons[cloneAuth].push(await cloneAddonForAccount(addon, acc));
          }

          continue;
        }

        // Sync mode: reproduce the Primary collection for normal addons, but replace
        // any Primary AIOStreams slot with the target account's own installed variant.
        const syncedAddons: AddonData[] = [];
        let handledAIOStreamsSlot = false;

        for (const addon of primaryAddons) {
          if (isAIOStreamsAddon(addon, primary.aiostreams_variant_url)) {
            if (!handledAIOStreamsSlot && targetAIOStreams.length > 0) {
              syncedAddons.push(...targetAIOStreams);
            }
            handledAIOStreamsSlot = true;
            continue;
          }

          // AIOmetadata and every other non-AIOStreams addon are copied normally.
          syncedAddons.push(await cloneAddonForAccount(addon, acc));
        }

        // If the user selected only a subset of Primary addons and that selection did
        // not contain AIOStreams, keep the target AIOStreams entry anyway. Insert it as
        // close as possible to its previous collection position.
        if (!handledAIOStreamsSlot && targetAIOStreams.length > 0) {
          const insertAt = Math.min(
            Math.max(targetAIOStreamsIndex, 0),
            syncedAddons.length
          );
          syncedAddons.splice(insertAt, 0, ...targetAIOStreams);
        }

        // If the target did not already have AIOStreams installed, intentionally do
        // not install the Primary variant. Variant installation remains an explicit
        // per-account action in the Variant Manager.
        clonedAddons[cloneAuth] = syncedAddons;
      } catch (err) {
        if (err instanceof Error) {
          throw new Error(`Clone Account #${index + 1}: ${err.message}`);
        }
      }
    }

    for (const [authKey, accountAddons] of Object.entries(clonedAddons)) {
      await pushAddonCollection(authKey, accountAddons);
    }

    const response: CloneResponse = {
      success: true,
      message: "Addons cloned successfully; AIOStreams variants preserved",
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err: unknown) {
    console.error("Error cloning addons:", err);

    const response: CloneResponse = {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error occurred",
    };

    return NextResponse.json(response, { status: 200 });
  }
}
