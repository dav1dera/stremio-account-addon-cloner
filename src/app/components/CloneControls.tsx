"use client";
import React, { useState } from "react";
import { Copy, ShieldCheck } from "lucide-react";
import { useAccounts } from "../hooks/useAccounts";
import { validateAccount, validateCloneAccounts } from "../utils/validation";
import { cloneAddons } from "../services/api";
import { Account } from "../types/accounts";

export default function CloneControls() {
    const { cloneAccounts, primaryAccount, setRememberDetails, rememberDetails, setAlert, addons } = useAccounts();
    const [loading, setLoading] = useState(false);

    const saveToLocalStorage = () => {
        if (!rememberDetails) {
            localStorage.removeItem("stremio_acounts_v1");
            return;
        }
        const encodedPrimary = btoa(JSON.stringify(primaryAccount));
        const encodedClones = btoa(JSON.stringify(cloneAccounts));

        localStorage.setItem(
            "stremio_acounts_v1",
            JSON.stringify({ primary: encodedPrimary, clones: encodedClones })
        );
    };

    const handleSubmit = async () => {
        const { valid, error } = validateAccount(primaryAccount, "Primary");
        if (!valid) {
            setAlert({ type: "error", message: error! });
            return;
        }

        const cloneValidation = validateCloneAccounts(cloneAccounts);
        if (!cloneValidation.valid) {
            setAlert({ type: "error", message: cloneValidation.error! });
            return;
        }

        setLoading(true);
        setAlert(null);

        try {
            saveToLocalStorage();
            const addonsToClone = addons.filter((addon) => addon.checked).map((addon) => addon.addon);
            const result = await cloneAddons(
                primaryAccount,
                cloneAccounts.filter((account) => account.selected),
                addonsToClone
            );
            setAlert({
                type: "success",
                message: result?.message || "Addons cloned successfully; AIOStreams variants preserved!"
            });
        } catch (err) {
            if (err instanceof Error) {
                setAlert({ type: "error", message: err.message });
            }
        } finally {
            setLoading(false);
        }
    };

    const getAccountsStats = () => {
        const selectedAccounts = cloneAccounts.filter((account: Account) => account.selected).length;
        const totalAccounts = cloneAccounts.length;
        return `${selectedAccounts} of ${totalAccounts} accounts selected`;
    };

    return (
        <div>
            {/* stats above button */}
            {!loading && (
                <div className="mb-2 text-sm text-gray-300 text-center">
                    {getAccountsStats()}
                </div>
            )}

            <div className="mb-3 flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-100">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                <span>
                    AIOStreams variants are protected during cloning. Sync/Append clone the other addons without replacing each target account&apos;s installed AIOStreams variant.
                </span>
            </div>

            <button
                type="button"
                onClick={handleSubmit}
                disabled={loading || !cloneAccounts.filter(account => account.selected).length}
                className="w-full flex items-center justify-center gap-2 
                           rounded-lg py-3 
                           bg-green-600 hover:bg-green-700 
                           disabled:bg-gray-600 disabled:hover:bg-gray-600 
                           text-white font-medium
                           transition-colors disabled:cursor-not-allowed"
            >
                <Copy className="w-5 h-5" />
                {loading ? "Cloning..." : "Clone Addons"}
            </button>

            <label className="flex items-center gap-2 text-gray-300 mt-4 cursor-pointer select-none">
                {/* custom checkbox */}
                <input
                    type="checkbox"
                    checked={rememberDetails}
                    onChange={(e) => setRememberDetails(e.target.checked)}
                    className="h-5 w-5 border-2 border-gray-400 rounded-sm 
                               bg-gray-700 checked:bg-blue-500 checked:border-blue-500 
                               focus:outline-none focus:ring-2 focus:ring-blue-400 
                               cursor-pointer transition-all"
                />
                <span>Remember my details</span>
            </label>
        </div>
    );
}
