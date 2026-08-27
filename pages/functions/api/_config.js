// Shared reader for the master-pushed config_kv blobs. Filenames starting with "_"
// are NOT routed by Pages, so this is a library, not an endpoint.
//
// config_kv holds opaque JSON the master mirrors here (years / whitelist / buildings /
// needsopen / health_excluded / assignments). It is DISPLAY data in every case: it
// changes what the dashboard draws, never what any client does. Reading it must never
// be able to fail a page — a missing key, a missing table, or unparseable JSON all
// return the caller's fallback.
export async function readConfigKey(env, key, fallback = null) {
  try {
    const row = await env.DB.prepare('SELECT json FROM config_kv WHERE key = ?').bind(key).first();
    if (!row || !row.json) return fallback;
    const v = JSON.parse(row.json);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
