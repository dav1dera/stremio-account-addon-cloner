import { Account } from "../types/accounts";
import { AddonData } from "../types/addon";
import { AddonsResponse } from "../types/apiResponse";

export type AIOStreamsRefreshResult = {
    index: number;
    success: boolean;
    variantUrl?: string;
    addonName?: string;
    message: string;
};

export type AIOStreamsRefreshResponse = {
    success: boolean;
    allSuccessful?: boolean;
    error?: string;
    results?: AIOStreamsRefreshResult[];
};

export type AIOStreamsApplyItem = {
    account: Account;
    variant: string;
};

export type AIOStreamsApplyResult = {
    index: number;
    success: boolean;
    variant?: string;
    variantUrl?: string;
    addonName?: string;
    message: string;
};

export type AIOStreamsApplyResponse = {
    success: boolean;
    allSuccessful?: boolean;
    error?: string;
    results?: AIOStreamsApplyResult[];
};

export type AIOStreamsVariantOption = {
    id: string;
    name?: string;
};

export type AIOStreamsVariantDiscoveryResponse = {
    success: boolean;
    error?: string;
    variants?: AIOStreamsVariantOption[];
    source?: {
        origin: string;
        identifier: string;
        mode: "alias" | "uuid" | "profile";
    };
};

export async function fetchAddons(account: Account) {
    const res = await fetch("/api/addons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
    });

    const result: AddonsResponse = await res.json();
    if (!result.success) throw new Error(result?.error || "Unknown error");
    return result.addons;
}

export async function cloneAddons(
    primaryAccount: Account,
    cloneAccounts: Account[],
    addons: AddonData[]
) {
    const data = JSON.stringify({
        primary: primaryAccount,
        clones: cloneAccounts,
        addons,
    });

    const res = await fetch("/api/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
    });

    const result = await res.json();
    if (!result.success) throw new Error(result?.error || "Unknown error");
    return result;
}

export async function updateAddons(
    account: Account,
    updatedAddons: AddonData[]
) {
    const data = JSON.stringify({
        account: account,
        addons: updatedAddons
    });

    const res = await fetch("/api/updateAddons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
    });

    const result = await res.json();
    if (!result.success) throw new Error(result?.error || "Unknown error");
    return result;
}

export async function refreshAIOStreamsVariants(accounts: Account[]) {
    const res = await fetch("/api/aiostreams/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
    });

    const result: AIOStreamsRefreshResponse = await res.json();
    if (!res.ok) throw new Error(result?.error || "AIOStreams refresh request failed");
    return result;
}

export async function applyAIOStreamsVariants(items: AIOStreamsApplyItem[]) {
    const res = await fetch("/api/aiostreams/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
    });

    const result: AIOStreamsApplyResponse = await res.json();
    if (!res.ok) throw new Error(result?.error || "AIOStreams variant apply request failed");
    return result;
}

type VariantDiscoveryOptions = {
    configPassword?: string;
    operatorUsername?: string;
    operatorPassword?: string;
};

export async function discoverAIOStreamsVariants(
    manifestUrl: string,
    optionsOrPassword: VariantDiscoveryOptions | string = {}
) {
    let options: VariantDiscoveryOptions;

    if (typeof optionsOrPassword === "string") {
        const password = optionsOrPassword.trim();
        const operatorUsername =
            typeof window !== "undefined"
                ? sessionStorage.getItem("aiostreams_operator_username_hint")?.trim() || undefined
                : undefined;

        // Backward-compatible path for the existing UI: when an alias is in use,
        // the single password field can act as the AIOSTREAMS_AUTH operator password.
        // The backend first resolves the saved profile by alias. It still receives the
        // same value as configPassword so direct alias-password auth remains a fallback.
        options = {
            configPassword: password || undefined,
            operatorUsername,
            operatorPassword: operatorUsername && password ? password : undefined,
        };
    } else {
        options = optionsOrPassword;
    }

    const res = await fetch("/api/aiostreams/variants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestUrl, ...options }),
    });

    const result: AIOStreamsVariantDiscoveryResponse = await res.json();
    if (!res.ok || !result.success) {
        throw new Error(result?.error || "AIOStreams variant discovery failed");
    }
    return result;
}
