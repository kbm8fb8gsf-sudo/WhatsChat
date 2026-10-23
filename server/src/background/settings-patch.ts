/**
 * Adjust the SillyTavern settings the hidden page loads (as JSON text), in memory only: the
 * hidden page never saves settings back. Pure.
 *
 * SillyTavern only connects to the AI on page load if "Auto-connect to Last Server" is ticked,
 * and it refuses to generate while disconnected, so the hidden page always auto-connects.
 */
export function withAutoConnect(settingsJson: string): string {
    let settings: unknown;
    try {
        settings = JSON.parse(settingsJson);
    } catch {
        return settingsJson;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return settingsJson;
    const record = settings as Record<string, unknown>;
    const powerUser = record['power_user'];
    const merged = typeof powerUser === 'object' && powerUser !== null ? { ...(powerUser as Record<string, unknown>) } : {};
    merged['auto_connect'] = true;
    return JSON.stringify({ ...record, power_user: merged });
}
