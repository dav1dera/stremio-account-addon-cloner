export type Account = {
    mode: "credentials" | "authkey";
    email: string;
    password: string;
    authkey: string;
    is_debrid_override: boolean;
    debrid_type: string;
    debrid_key: string;
    clone_mode: "sync" | "append";
    selected?: boolean;
    aiostreams_variant_url?: string;
    /** Legacy single-variant field kept for backwards compatibility. */
    aiostreams_variant_name?: string;
    /** AIOStreams supports combining multiple variant ids in one manifest URL. */
    aiostreams_variant_names?: string[];
    aiostreams_config_password?: string;
    aiostreams_operator_username?: string;
    aiostreams_operator_password?: string;
};
