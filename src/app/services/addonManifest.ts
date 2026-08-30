export async function fetchAddonManifest(manifest: string) {
    const res = await fetch(manifest);
    const result = await res.json();

    if (!res.ok) throw new Error(result.statusText || "Unknown error");

    return result;
}

export async function fetchAddonManifestViaProxy(manifestUrl: string) {
    const res = await fetch("/api/manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: manifestUrl }),
    });

    const result = await res.json();
    if (!res.ok || !result.success) {
        throw new Error(result?.error || "Failed to fetch manifest");
    }

    return result.manifest;
}
