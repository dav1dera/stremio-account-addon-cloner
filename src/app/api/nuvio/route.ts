import { NextResponse } from "next/server";
import {
  nuvioGetAddons,
  nuvioGetProfiles,
  nuvioLogin,
  nuvioPushAddons,
} from "@/app/lib/nuvio-client";

type IncomingAddon = {
  url?: unknown;
  name?: unknown;
  enabled?: unknown;
};

type NormalizedAddon = {
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
};

type NuvioAuth = {
  access_token?: string;
  user?: unknown;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === "login") {
      const email = String(body?.email || "").trim();
      const password = String(body?.password || "");
      if (!email || !password) {
        return NextResponse.json({ success: false, error: "Email and password are required" }, { status: 400 });
      }

      const auth = await nuvioLogin(email, password) as NuvioAuth;
      const accessToken = String(auth?.access_token || "").trim();
      if (!accessToken) {
        return NextResponse.json({ success: false, error: "Nuvio did not return an access token" }, { status: 401 });
      }

      const profiles = await nuvioGetProfiles(accessToken);
      return NextResponse.json({ success: true, auth, profiles });
    }

    const token = String(body?.token || "").trim();
    if (!token) {
      return NextResponse.json({ success: false, error: "Missing Nuvio access token" }, { status: 401 });
    }

    if (action === "profiles") {
      const profiles = await nuvioGetProfiles(token);
      return NextResponse.json({ success: true, profiles });
    }

    if (action === "addons") {
      const profileId = Number(body?.profileId);
      if (!Number.isFinite(profileId)) {
        return NextResponse.json({ success: false, error: "Invalid profile id" }, { status: 400 });
      }
      const addons = await nuvioGetAddons(token, profileId);
      return NextResponse.json({ success: true, addons });
    }

    if (action === "saveAddons") {
      const profileId = Number(body?.profileId);
      if (!Number.isFinite(profileId) || !Array.isArray(body?.addons)) {
        return NextResponse.json({ success: false, error: "Invalid addon payload" }, { status: 400 });
      }

      const addons: NormalizedAddon[] = (body.addons as IncomingAddon[])
        .map((addon, index) => ({
          url: String(addon?.url || "").trim(),
          name: addon?.name == null ? null : String(addon.name),
          enabled: addon?.enabled !== false,
          sort_order: index,
        }))
        .filter((addon) => addon.url.length > 0);

      await nuvioPushAddons(token, profileId, addons);
      const refreshed = await nuvioGetAddons(token, profileId);
      return NextResponse.json({ success: true, addons: refreshed });
    }

    return NextResponse.json({ success: false, error: "Unknown Nuvio action" }, { status: 400 });
  } catch (err: unknown) {
    console.error("Nuvio API error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Unknown Nuvio error" },
      { status: 500 }
    );
  }
}
