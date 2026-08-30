"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Search, XCircle } from "lucide-react";
import { useAccounts } from "../hooks/useAccounts";
import type { Account } from "../types/accounts";
import type { AddonData } from "../types/addon";
import {
    applyAIOStreamsVariants,
    discoverAIOStreamsVariants,
    fetchAddons,
    refreshAIOStreamsVariants,
    type AIOStreamsVariantOption,
} from "../services/api";

type AccountRef = {
    key: string;
    label: string;
    kind: "primary" | "clone";
    index?: number;
    account: Account;
};

type Status = {
    type: "success" | "error" | "info";
    message: string;
};

type CatalogStatus = {
    type: "success" | "error" | "info";
    message: string;
} | null;

function hasCredentials(account: Account) {
    if (account.mode === "authkey") return Boolean(account.authkey?.trim());
    return Boolean(account.email?.trim() && account.password);
}

function normalizeForComparison(url: string) {
    return (url || "").replace(/^stremio:\/\//, "https://").replace(/\/$/, "");
}

function usesAlias(url: string) {
    try {
        return /\/stremio\/u\/[^/]+\//i.test(new URL(normalizeForComparison(url)).pathname);
    } catch {
        return false;
    }
}

function variantNameFromUrl(url: string) {
    try {
        const parsed = new URL(normalizeForComparison(url));
        const pathMatch = parsed.pathname.match(/\/v\/([^/]+)\/manifest\.json$/i);
        if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]).toLowerCase();
        return (parsed.searchParams.get("v") || "").toLowerCase();
    } catch {
        return "";
    }
}

function looksLikeAIOStreams(addon: AddonData) {
    const id = addon?.manifest?.id?.toLowerCase?.() || "";
    const name = addon?.manifest?.name?.toLowerCase?.() || "";

    // Do not identify AIOStreams from a generic /stremio/... manifest URL.
    // AIOmetadata and other addons use similar per-user URL layouts.
    return id.includes("aiostreams") || name.includes("aiostreams");
}

function findInstalledVariant(addons: AddonData[]) {
    const candidates = addons.filter(looksLikeAIOStreams);
    if (candidates.length === 0) return undefined;

    const explicitVariant = candidates.find((addon) => Boolean(variantNameFromUrl(addon.transportUrl)));
    return explicitVariant || candidates[0];
}

export default function AIOStreamsVariantManager() {
    const {
        primaryAccount,
        setPrimaryAccount,
        cloneAccounts,
        setCloneAccounts,
        rememberDetails,
        setAlert,
    } = useAccounts();

    const [statuses, setStatuses] = useState<Record<string, Status>>({});
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [bulkBusy, setBulkBusy] = useState<"detect" | "refresh" | "apply" | null>(null);
    const [availableVariants, setAvailableVariants] = useState<AIOStreamsVariantOption[]>([]);
    const [catalogBusy, setCatalogBusy] = useState(false);
    const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>(null);

    const refs = useMemo<AccountRef[]>(() => {
        const primaryLabel = primaryAccount.email?.trim()
            ? `Primary — ${primaryAccount.email}`
            : "Primary account";

        return [
            {
                key: "primary",
                label: primaryLabel,
                kind: "primary",
                account: primaryAccount,
            },
            ...cloneAccounts.map((account, index) => ({
                key: `clone-${index}`,
                label: account.email?.trim() ? `Account #${index + 1} — ${account.email}` : `Account #${index + 1}`,
                kind: "clone" as const,
                index,
                account,
            })),
        ];
    }, [primaryAccount, cloneAccounts]);

    const bulkRefs = useMemo(
        () => refs.filter((ref) => ref.kind === "primary" || ref.account.selected !== false),
        [refs]
    );

    useEffect(() => {
        if (!rememberDetails) return;
        const encodedPrimary = btoa(JSON.stringify(primaryAccount));
        const encodedClones = btoa(JSON.stringify(cloneAccounts));
        localStorage.setItem(
            "stremio_acounts_v1",
            JSON.stringify({ primary: encodedPrimary, clones: encodedClones })
        );
    }, [rememberDetails, primaryAccount, cloneAccounts]);

    useEffect(() => {
        const manifestUrl = primaryAccount.aiostreams_variant_url?.trim();
        const configPassword = primaryAccount.aiostreams_config_password?.trim();
        if (!manifestUrl) return;
        if (usesAlias(manifestUrl) && !configPassword) return;

        let cancelled = false;
        const timer = window.setTimeout(async () => {
            try {
                const result = await discoverAIOStreamsVariants(manifestUrl, configPassword);
                if (cancelled) return;
                setAvailableVariants(result.variants || []);
                setCatalogStatus({
                    type: "success",
                    message: `${result.variants?.length || 0} enabled variant${(result.variants?.length || 0) === 1 ? "" : "s"} loaded automatically`,
                });
            } catch (error) {
                if (cancelled) return;
                setCatalogStatus({
                    type: "error",
                    message: error instanceof Error ? error.message : "Could not load AIOStreams variants",
                });
            }
        }, 600);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [primaryAccount.aiostreams_variant_url, primaryAccount.aiostreams_config_password]);

    const setStatus = (key: string, status: Status) => {
        setStatuses((prev) => ({ ...prev, [key]: status }));
    };

    const updateVariantUrl = (ref: AccountRef, url: string) => {
        if (ref.kind === "primary") {
            setPrimaryAccount((prev) => ({ ...prev, aiostreams_variant_url: url }));
            return;
        }

        setCloneAccounts((prev) =>
            prev.map((account, index) =>
                index === ref.index ? { ...account, aiostreams_variant_url: url } : account
            )
        );
    };

    const updateVariantName = (ref: AccountRef, variant: string) => {
        if (ref.kind === "primary") {
            setPrimaryAccount((prev) => ({ ...prev, aiostreams_variant_name: variant }));
            return;
        }

        setCloneAccounts((prev) =>
            prev.map((account, index) =>
                index === ref.index ? { ...account, aiostreams_variant_name: variant } : account
            )
        );
    };

    const updateConfigPassword = (value: string) => {
        setPrimaryAccount((prev) => ({ ...prev, aiostreams_config_password: value }));
    };

    const detectVariant = async (account: Account) => {
        if (!hasCredentials(account)) {
            throw new Error("Add Stremio credentials or an AuthKey first");
        }

        const addons = (await fetchAddons(account)) as AddonData[];
        const addon = findInstalledVariant(addons);
        if (!addon?.transportUrl) {
            throw new Error("No installed AIOStreams addon was detected");
        }

        const url = normalizeForComparison(addon.transportUrl);
        return { url, variant: variantNameFromUrl(url) };
    };

    const loadVariantCatalog = async (silent = false) => {
        let manifestUrl = primaryAccount.aiostreams_variant_url?.trim();
        const configPassword = primaryAccount.aiostreams_config_password?.trim();

        if (!manifestUrl) {
            const detected = await detectVariant(primaryAccount);
            manifestUrl = detected.url;
            setPrimaryAccount((prev) => ({ ...prev, aiostreams_variant_url: detected.url }));
        }

        if (!silent) {
            setCatalogBusy(true);
            setCatalogStatus({ type: "info", message: "Loading variants from AIOStreams…" });
        }

        try {
            const result = await discoverAIOStreamsVariants(manifestUrl, configPassword);
            const variants = result.variants || [];
            setAvailableVariants(variants);
            setCatalogStatus({
                type: "success",
                message: `${variants.length} enabled variant${variants.length === 1 ? "" : "s"} loaded from ${result.source?.mode === "alias" ? `alias ${result.source.identifier}` : "configuration"}`,
            });
            return variants;
        } catch (error) {
            setCatalogStatus({
                type: "error",
                message: error instanceof Error ? error.message : "Could not load AIOStreams variants",
            });
            if (!silent) throw error;
            return [];
        } finally {
            if (!silent) setCatalogBusy(false);
        }
    };

    const handleDetect = async (ref: AccountRef) => {
        setBusy((prev) => ({ ...prev, [ref.key]: true }));
        setStatus(ref.key, { type: "info", message: "Detecting installed variant…" });
        try {
            const detected = await detectVariant(ref.account);
            updateVariantUrl(ref, detected.url);
            if (detected.variant) updateVariantName(ref, detected.variant);
            setStatus(ref.key, {
                type: "success",
                message: detected.variant
                    ? `Installed variant detected: ${detected.variant}`
                    : "AIOStreams base/main install detected",
            });
        } catch (error) {
            setStatus(ref.key, {
                type: "error",
                message: error instanceof Error ? error.message : "Variant detection failed",
            });
        } finally {
            setBusy((prev) => ({ ...prev, [ref.key]: false }));
        }
    };

    const refreshOne = async (ref: AccountRef) => {
        setBusy((prev) => ({ ...prev, [ref.key]: true }));
        setStatus(ref.key, { type: "info", message: "Refreshing AIOStreams…" });

        try {
            if (!hasCredentials(ref.account)) {
                throw new Error("Add Stremio credentials or an AuthKey first");
            }

            const response = await refreshAIOStreamsVariants([ref.account]);
            const result = response.results?.[0];
            if (!result?.success) {
                throw new Error(result?.message || response.error || "Refresh failed");
            }

            if (result.variantUrl) updateVariantUrl(ref, result.variantUrl);
            setStatus(ref.key, { type: "success", message: result.message });
        } catch (error) {
            setStatus(ref.key, {
                type: "error",
                message: error instanceof Error ? error.message : "Refresh failed",
            });
        } finally {
            setBusy((prev) => ({ ...prev, [ref.key]: false }));
        }
    };

    const applyOne = async (ref: AccountRef) => {
        setBusy((prev) => ({ ...prev, [ref.key]: true }));
        const variant = ref.account.aiostreams_variant_name?.trim();
        setStatus(ref.key, { type: "info", message: "Applying selected variant…" });

        try {
            if (!hasCredentials(ref.account)) {
                throw new Error("Add Stremio credentials or an AuthKey first");
            }
            if (!variant) throw new Error("Choose a variant first");

            const response = await applyAIOStreamsVariants([{ account: ref.account, variant }]);
            const result = response.results?.[0];
            if (!result?.success) {
                throw new Error(result?.message || response.error || "Variant apply failed");
            }

            if (result.variantUrl) updateVariantUrl(ref, result.variantUrl);
            setStatus(ref.key, { type: "success", message: result.message });
        } catch (error) {
            setStatus(ref.key, {
                type: "error",
                message: error instanceof Error ? error.message : "Variant apply failed",
            });
        } finally {
            setBusy((prev) => ({ ...prev, [ref.key]: false }));
        }
    };

    const detectAll = async () => {
        setBulkBusy("detect");
        let detectedCount = 0;
        let failed = 0;

        for (const ref of bulkRefs) {
            if (!hasCredentials(ref.account)) continue;
            setStatus(ref.key, { type: "info", message: "Detecting installed variant…" });
            try {
                const detected = await detectVariant(ref.account);
                updateVariantUrl(ref, detected.url);
                if (detected.variant) updateVariantName(ref, detected.variant);
                setStatus(ref.key, {
                    type: "success",
                    message: detected.variant
                        ? `Installed variant detected: ${detected.variant}`
                        : "AIOStreams base/main install detected",
                });
                detectedCount += 1;
            } catch (error) {
                failed += 1;
                setStatus(ref.key, {
                    type: "error",
                    message: error instanceof Error ? error.message : "Variant detection failed",
                });
            }
        }

        setBulkBusy(null);
        setAlert({
            type: failed ? "error" : "success",
            message: `AIOStreams detection complete: ${detectedCount} detected${failed ? `, ${failed} failed` : ""}.`,
        });
    };

    const refreshAll = async () => {
        setBulkBusy("refresh");
        const prepared = bulkRefs.filter((ref) => hasCredentials(ref.account));

        if (prepared.length === 0) {
            setBulkBusy(null);
            setAlert({ type: "error", message: "No configured Stremio accounts are ready to refresh." });
            return;
        }

        await loadVariantCatalog(true);
        prepared.forEach((ref) => setStatus(ref.key, { type: "info", message: "Queued for safe refresh…" }));

        try {
            const response = await refreshAIOStreamsVariants(prepared.map((item) => item.account));
            const results = response.results || [];
            let successCount = 0;
            let failureCount = 0;

            prepared.forEach((ref, index) => {
                const result = results[index];
                if (result?.success) {
                    successCount += 1;
                    if (result.variantUrl) updateVariantUrl(ref, result.variantUrl);
                    setStatus(ref.key, { type: "success", message: result.message });
                } else {
                    failureCount += 1;
                    setStatus(ref.key, {
                        type: "error",
                        message: result?.message || "Refresh failed",
                    });
                }
            });

            setAlert({
                type: failureCount ? "error" : "success",
                message: `AIOStreams refresh complete: ${successCount} refreshed${failureCount ? `, ${failureCount} failed` : ""}.`,
            });
        } catch (error) {
            setAlert({
                type: "error",
                message: error instanceof Error ? error.message : "Bulk refresh failed",
            });
        } finally {
            setBulkBusy(null);
        }
    };

    const applyAll = async () => {
        const prepared = bulkRefs.filter(
            (ref) => hasCredentials(ref.account) && Boolean(ref.account.aiostreams_variant_name?.trim())
        );

        if (prepared.length === 0) {
            setAlert({ type: "error", message: "Choose at least one variant before Apply All Variants." });
            return;
        }

        setBulkBusy("apply");
        prepared.forEach((ref) => setStatus(ref.key, { type: "info", message: "Queued for variant apply…" }));

        try {
            const response = await applyAIOStreamsVariants(
                prepared.map((ref) => ({
                    account: ref.account,
                    variant: ref.account.aiostreams_variant_name!.trim(),
                }))
            );
            const results = response.results || [];
            let successCount = 0;
            let failureCount = 0;

            prepared.forEach((ref, index) => {
                const result = results[index];
                if (result?.success) {
                    successCount += 1;
                    if (result.variantUrl) updateVariantUrl(ref, result.variantUrl);
                    setStatus(ref.key, { type: "success", message: result.message });
                } else {
                    failureCount += 1;
                    setStatus(ref.key, {
                        type: "error",
                        message: result?.message || "Variant apply failed",
                    });
                }
            });

            setAlert({
                type: failureCount ? "error" : "success",
                message: `Variant apply complete: ${successCount} applied${failureCount ? `, ${failureCount} failed` : ""}.`,
            });
        } catch (error) {
            setAlert({
                type: "error",
                message: error instanceof Error ? error.message : "Bulk variant apply failed",
            });
        } finally {
            setBulkBusy(null);
        }
    };

    const primaryManifestUrl = primaryAccount.aiostreams_variant_url || "";
    const aliasInstall = usesAlias(primaryManifestUrl);

    return (
        <section className="rounded-xl border border-blue-700/50 bg-gray-900/40 p-4 space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">AIOStreams Variant Manager</h2>
                    <p className="mt-1 text-sm text-gray-300">
                        Variants are loaded live from your AIOStreams configuration. Refresh updates installed manifests without changing variants; Apply Variant changes them intentionally.
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                        Bulk actions include the Primary account and target accounts selected above. Apply All ignores accounts with no variant selected.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={detectAll} disabled={bulkBusy !== null} className="flex items-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50">
                        <Search className="h-4 w-4" />
                        {bulkBusy === "detect" ? "Detecting…" : "Detect All"}
                    </button>
                    <button type="button" onClick={applyAll} disabled={bulkBusy !== null} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <CheckCircle2 className="h-4 w-4" />
                        {bulkBusy === "apply" ? "Applying…" : "Apply All Variants"}
                    </button>
                    <button type="button" onClick={refreshAll} disabled={bulkBusy !== null} className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <RefreshCw className={`h-4 w-4 ${bulkBusy === "refresh" ? "animate-spin" : ""}`} />
                        {bulkBusy === "refresh" ? "Refreshing…" : "Refresh All"}
                    </button>
                </div>
            </div>

            <div className="rounded-lg border border-indigo-700/50 bg-indigo-950/20 p-3">
                <div className="mb-2 flex flex-col gap-1">
                    <div className="text-sm font-semibold text-indigo-200">Dynamic variant discovery</div>
                    <div className="text-xs text-gray-400">
                        {aliasInstall
                            ? "Your Primary uses an AIOStreams alias. Enter the AIOStreams configuration password once; the alias and server are detected from the installed manifest URL."
                            : "Server and configuration credentials are derived from the Primary AIOStreams manifest URL when possible."}
                    </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                    <input type="password" value={primaryAccount.aiostreams_config_password || ""} onChange={(event) => updateConfigPassword(event.target.value)} placeholder={aliasInstall ? "AIOStreams configuration password" : "Config password (optional if present in URL)"} className="min-w-0 flex-1 rounded-lg border border-indigo-700/70 bg-gray-900 p-2 text-sm text-white placeholder-gray-500" autoComplete="off" />
                    <button type="button" onClick={() => loadVariantCatalog(false)} disabled={catalogBusy || bulkBusy !== null} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50">
                        <RefreshCw className={`h-4 w-4 ${catalogBusy ? "animate-spin" : ""}`} />
                        {catalogBusy ? "Loading…" : "Reload Variants"}
                    </button>
                </div>
                {catalogStatus && (
                    <div className={`mt-2 text-xs ${catalogStatus.type === "success" ? "text-green-400" : catalogStatus.type === "error" ? "text-red-400" : "text-blue-300"}`}>
                        {catalogStatus.message}
                    </div>
                )}
            </div>

            <div className="space-y-3">
                {refs.map((ref) => {
                    const status = statuses[ref.key];
                    const isExcluded = ref.kind === "clone" && ref.account.selected === false;
                    const selectedVariant = ref.account.aiostreams_variant_name || "";
                    const variantOptions = selectedVariant && !availableVariants.some((variant) => variant.id === selectedVariant)
                        ? [{ id: selectedVariant, name: `${selectedVariant} (currently assigned)` }, ...availableVariants]
                        : availableVariants;

                    return (
                        <div key={ref.key} className={`rounded-lg border p-3 ${isExcluded ? "border-gray-700 bg-gray-800/30 opacity-60" : "border-gray-700 bg-gray-800/70"}`}>
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="text-sm font-semibold text-gray-200">{ref.label}</div>
                                {isExcluded && <span className="text-xs text-gray-500">Excluded from bulk</span>}
                            </div>

                            <div className="flex flex-col gap-2 lg:flex-row">
                                <input type="text" value={ref.account.aiostreams_variant_url || ""} onChange={(event) => updateVariantUrl(ref, event.target.value)} placeholder="Installed AIOStreams manifest URL" className="min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-900 p-2 text-sm text-white placeholder-gray-500" />
                                <button type="button" onClick={() => handleDetect(ref)} disabled={busy[ref.key] || bulkBusy !== null} className="flex items-center justify-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"><Search className="h-4 w-4" />Detect</button>
                                <button type="button" onClick={() => refreshOne(ref)} disabled={busy[ref.key] || bulkBusy !== null} className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${busy[ref.key] ? "animate-spin" : ""}`} />Refresh</button>
                            </div>

                            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                                <select value={selectedVariant} onChange={(event) => updateVariantName(ref, event.target.value)} className="min-w-0 flex-1 rounded-lg border border-indigo-700/70 bg-gray-900 p-2 text-sm text-white">
                                    <option value="">Choose variant — no change</option>
                                    {variantOptions.map((variant) => (
                                        <option key={variant.id} value={variant.id}>
                                            {variant.name && variant.name !== variant.id ? `${variant.name} (${variant.id})` : variant.id}
                                        </option>
                                    ))}
                                </select>
                                <button type="button" onClick={() => applyOne(ref)} disabled={busy[ref.key] || bulkBusy !== null || !selectedVariant} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />Apply Variant</button>
                            </div>

                            {status && (
                                <div className={`mt-2 flex items-start gap-2 text-xs ${status.type === "success" ? "text-green-400" : status.type === "error" ? "text-red-400" : "text-blue-300"}`}>
                                    {status.type === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : status.type === "error" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />}
                                    <span className="break-all">{status.message}</span>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
