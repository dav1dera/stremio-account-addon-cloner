import { NextResponse } from "next/server";

const MANIFEST_TIMEOUT_MS = 15000;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const manifestUrl = typeof body?.url === "string" ? body.url.trim() : "";

        if (!manifestUrl) {
            return NextResponse.json(
                { success: false, error: "Manifest URL is required" },
                { status: 400 }
            );
        }

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(manifestUrl);
        } catch {
            return NextResponse.json(
                { success: false, error: "Invalid manifest URL" },
                { status: 400 }
            );
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return NextResponse.json(
                { success: false, error: "Manifest URL must use HTTP or HTTPS" },
                { status: 400 }
            );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);

        try {
            const res = await fetch(parsedUrl.toString(), {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    "User-Agent": "stremio-account-addon-cloner/1.0",
                },
                cache: "no-store",
                redirect: "follow",
                signal: controller.signal,
            });

            const text = await res.text();

            if (!res.ok) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `Manifest request failed with HTTP ${res.status}`,
                    },
                    { status: 502 }
                );
            }

            let manifest: unknown;
            try {
                manifest = JSON.parse(text);
            } catch {
                return NextResponse.json(
                    { success: false, error: "Manifest response is not valid JSON" },
                    { status: 502 }
                );
            }

            return NextResponse.json({ success: true, manifest }, { status: 200 });
        } finally {
            clearTimeout(timeout);
        }
    } catch (err: unknown) {
        const message =
            err instanceof Error
                ? err.name === "AbortError"
                    ? "Manifest request timed out"
                    : err.message
                : "Failed to fetch manifest";

        console.error("Error fetching addon manifest:", err);
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
