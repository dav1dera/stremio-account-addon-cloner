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
