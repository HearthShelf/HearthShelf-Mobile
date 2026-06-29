/**
 * Spike configuration.
 *
 * The control-plane URL and Clerk publishable key mirror the web app
 * (HearthShelf-WebApp/.env.local). The publishable key is NOT a secret - it
 * ships in the web bundle today - so it's safe to inline for the spike. A real
 * build would read these from app config / EAS secrets.
 */

// Control plane REST API (server pairing, grants). Web app calls this as
// CONTROL_PLANE_URL; production is api.hearthshelf.com.
export const CONTROL_PLANE_URL = 'https://api.hearthshelf.com'

// Clerk publishable key (public by design - same one the SPA ships).
// pk_live_...hearthshelf.com
export const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuaGVhcnRoc2hlbGYuY29tJA'

// Deep-link scheme for Clerk OAuth redirects (matches app.json "scheme").
export const APP_SCHEME = 'hearthshelf'
