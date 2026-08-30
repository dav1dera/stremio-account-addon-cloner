"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Search, XCircle } from "lucide-react";
import { useAccounts } from "../hooks/useAccounts";
import type { Account } from "../types/accounts";
import type { AddonData } from "../types/addon";
import { fetchAddons, refreshAIOStreamsVariants } from "../services/api";

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

function hasCredentials(account: Account) {
    if (account.mode === "authkey") return Boolean(account.authkey?.trim());
    return Boolean(account.email?.trim() && account.password);
}

function normalizeForComparison(url: string) {
    return (url || "").replace(/^stremio:\/\//, "https://").replace(/\/$/, "");
}

function looksLikeAIOStreams(addon: AddonData) {
    const id = addon?.manifest?.id?.toLowerCase?.() || "";
    const name = addon?.manifest?.name?.toLowerCase?.() || "";
    const url = normalizeForComparison(addon?.transportUrl || "").toLowerCase();

    return (
        id.includes("aiostreams") ||
        name.includes("aiostreams") ||
        (url.includes("/stremio/") && url.includes("/v/") && url.endsWith("/manifest.json"))
    );
}

function findInstalledVariant(addons: AddonData[]) {
    const identified = addons.find(looksLikeAIOStreams);
    if (identified) return identified;

    // Fallback for custom ADDON_NAME/ADDON_ID installations. Prefer a
    // variant-looking /stremio/... URL rather than an arbitrary addon.
    return addons.find((addon) => {
        const url = normalizeForComparison(addon?.transportUrl || "").toLowerCase();
        return url.includes("/stremio/") && url.endsWith("/manifest.json");
    });
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
    const [bulkBusy, setBulkBusy] = useState<"detect" | "refresh" | null>(null);

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

    // The upstream app already stores account details in localStorage when
    // "Remember my details" is enabled. Keep variant URLs in the same payload
    // so detected variants survive page reloads too.
    useEffect(() => {
        if (!rememberDetails) return;
        const encodedPrimary = btoa(JSON.stringify(primaryAccount));
        const encodedClones = btoa(JSON.stringify(cloneAccounts));
        localStorage.setItem(
            "stremio_acounts_v1",
            JSON.stringify({ primary: encodedPrimary, clones: encodedClones })
        );
    }, [rememberDetails, primaryAccount, cloneAccounts]);

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

    const detectVariantUrl = async (account: Account) => {
        if (!hasCredentials(account)) {
            throw new Error("Add Stremio credentials or an AuthKey first");
        }

        const addons = (await fetchAddons(account)) as AddonData[];
        const addon = findInstalledVariant(addons);
        if (!addon?.transportUrl) {
            throw new Error("No installed AIOStreams addon was detected");
        }

        return normalizeForComparison(addon.transportUrl);
    };

    const handleDetect = async (ref: AccountRef) => {
        setBusy((prev) => ({ ...prev, [ref.key]: true }));
        setStatus(ref.key, { type: "info", message: "Detecting installed variant…" });
        try {
            const url = await detectVariantUrl(ref.account);
            updateVariantUrl(ref, url);
            setStatus(ref.key, { type: "success", message: "Installed variant detected" });
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

            let account = ref.account;
            let variantUrl = account.aiostreams_variant_url?.trim();

            if (!variantUrl) {
                variantUrl = await detectVariantUrl(account);
                updateVariantUrl(ref, variantUrl);
                account = { ...account, aiostreams_variant_url: variantUrl };
            }

            const response = await refreshAIOStreamsVariants([account]);
            const result = response.results?.[0];
            if (!result?.success) {
                throw new Error(result?.message || response.error || "Refresh failed");
            }

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

    const detectAll = async () => {
        setBulkBusy("detect");
        let detected = 0;
        let failed = 0;

        for (const ref of bulkRefs) {
            if (!hasCredentials(ref.account)) continue;
            setStatus(ref.key, { type: "info", message: "Detecting installed variant…" });
            try {
                const url = await detectVariantUrl(ref.account);
                updateVariantUrl(ref, url);
                setStatus(ref.key, { type: "success", message: "Installed variant detected" });
                detected += 1;
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
            message: `AIOStreams detection complete: ${detected} detected${failed ? `, ${failed} failed` : ""}.`,
        });
    };

    const refreshAll = async () => {
        setBulkBusy("refresh");
        const prepared: { ref: AccountRef; account: Account }[] = [];

        for (const ref of bulkRefs) {
            if (!hasCredentials(ref.account)) continue;
            try {
                let account = ref.account;
                let variantUrl = account.aiostreams_variant_url?.trim();

                if (!variantUrl) {
                    setStatus(ref.key, { type: "info", message: "Detecting variant before refresh…" });
                    variantUrl = await detectVariantUrl(account);
                    updateVariantUrl(ref, variantUrl);
                    account = { ...account, aiostreams_variant_url: variantUrl };
                }

                prepared.push({ ref, account });
                setStatus(ref.key, { type: "info", message: "Queued for refresh…" });
            } catch (error) {
                setStatus(ref.key, {
                    type: "error",
                    message: error instanceof Error ? error.message : "Could not prepare account",
                });
            }
        }

        if (prepared.length === 0) {
            setBulkBusy(null);
            setAlert({ type: "error", message: "No configured Stremio accounts are ready to refresh." });
            return;
        }

        try {
            const response = await refreshAIOStreamsVariants(prepared.map((item) => item.account));
            const results = response.results || [];
            let successCount = 0;
            let failureCount = 0;

            prepared.forEach((item, index) => {
                const result = results[index];
                if (result?.success) {
                    successCount += 1;
                    setStatus(item.ref.key, { type: "success", message: result.message });
                } else {
                    failureCount += 1;
                    setStatus(item.ref.key, {
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

    return (
        <section className="rounded-xl border border-blue-700/50 bg-gray-900/40 p-4 space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">AIOStreams Variant Manager</h2>
                    <p className="mt-1 text-sm text-gray-300">
                        Detect each account&apos;s installed AIOStreams variant and refresh its manifest in place without changing addon order.
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                        Bulk actions include the Primary account and target accounts selected above.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={detectAll}
                        disabled={bulkBusy !== null}
                        className="flex items-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Search className="h-4 w-4" />
                        {bulkBusy === "detect" ? "Detecting…" : "Detect All"}
                    </button>
                    <button
                        type="button"
                        onClick={refreshAll}
                        disabled={bulkBusy !== null}
                        className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <RefreshCw className={`h-4 w-4 ${bulkBusy === "refresh" ? "animate-spin" : ""}`} />
                        {bulkBusy === "refresh" ? "Refreshing…" : "Refresh All"}
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                {refs.map((ref) => {
                    const status = statuses[ref.key];
                    const isExcluded = ref.kind === "clone" && ref.account.selected === false;
                    return (
                        <div
                            key={ref.key}
                            className={`rounded-lg border p-3 ${isExcluded ? "border-gray-700 bg-gray-800/30 opacity-60" : "border-gray-700 bg-gray-800/70"}`}
                        >
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="text-sm font-semibold text-gray-200">{ref.label}</div>
                                {isExcluded && <span className="text-xs text-gray-500">Excluded from bulk</span>}
                            </div>

                            <div className="flex flex-col gap-2 lg:flex-row">
                                <input
                                    type="text"
                                    value={ref.account.aiostreams_variant_url || ""}
                                    onChange={(event) => updateVariantUrl(ref, event.target.value)}
                                    placeholder="https://aiostreams.example/stremio/.../v/.../manifest.json"
                                    className="min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-900 p-2 text-sm text-white placeholder-gray-500"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleDetect(ref)}
                                    disabled={busy[ref.key] || bulkBusy !== null}
                                    className="flex items-center justify-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Search className="h-4 w-4" />
                                    Detect
                                </button>
                                <button
                                    type="button"
                                    onClick={() => refreshOne(ref)}
                                    disabled={busy[ref.key] || bulkBusy !== null}
                                    className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <RefreshCw className={`h-4 w-4 ${busy[ref.key] ? "animate-spin" : ""}`} />
                                    Refresh
                                </button>
                            </div>

                            {status && (
                                <div
                                    className={`mt-2 flex items-start gap-2 text-xs ${
                                        status.type === "success"
                                            ? "text-green-400"
                                            : status.type === "error"
                                                ? "text-red-400"
                                                : "text-blue-300"
                                    }`}
                                >
                                    {status.type === "success" ? (
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                    ) : status.type === "error" ? (
                                        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                    ) : (
                                        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                                    )}
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
