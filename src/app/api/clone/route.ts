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

        const targetAIOStreams = existingAddons.filter((addon) =>
          isAIOStreamsAddon(addon, acc.aiostreams_variant_url)
        );
        const targetAIOStreamsIndex = existingAddons.findIndex((addon) =>
          isAIOStreamsAddon(addon, acc.aiostreams_variant_url)
        );

        if (acc.clone_mode === "append") {
          clonedAddons[cloneAuth] = [...existingAddons];

          for (const addon of primaryAddons) {
            if (isAIOStreamsAddon(addon, primary.aiostreams_variant_url)) {
              // Preserve a target-specific AIOStreams install when present, but
              // install the Primary AIOStreams entry if the target has none.
              if (targetAIOStreams.length === 0) {
                clonedAddons[cloneAuth].push({ ...addon });
              }
              continue;
            }

            if (addon.manifest.id.includes("cinemeta")) {
              continue;
            }

            clonedAddons[cloneAuth].push(await cloneAddonForAccount(addon, acc));
          }

          continue;
        }

        const syncedAddons: AddonData[] = [];
        let handledAIOStreamsSlot = false;

        for (const addon of primaryAddons) {
          if (isAIOStreamsAddon(addon, primary.aiostreams_variant_url)) {
            if (!handledAIOStreamsSlot) {
              if (targetAIOStreams.length > 0) {
                // Existing target variants always win.
                syncedAddons.push(...targetAIOStreams);
              } else {
                // If AIOStreams is missing entirely, clone the Primary install so
                // Clone Addons behaves like users expect. It can be customized later
                // from the Variant Manager.
                syncedAddons.push({ ...addon });
              }
            }
            handledAIOStreamsSlot = true;
            continue;
          }

          syncedAddons.push(await cloneAddonForAccount(addon, acc));
        }

        // If AIOStreams was not selected from Primary, preserve an existing target
        // install in sync mode so a partial clone does not remove it.
        if (!handledAIOStreamsSlot && targetAIOStreams.length > 0) {
          const insertAt = Math.min(
            Math.max(targetAIOStreamsIndex, 0),
            syncedAddons.length
          );
          syncedAddons.splice(insertAt, 0, ...targetAIOStreams);
        }

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
      message: "Addons cloned successfully; existing AIOStreams variants preserved and missing installs restored",
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
