/* =====================================================================
   FinTrack Pocket - js/geo.js
   GEOLOCATION: the user's position (only after they allow it), turned
   into a Promise, with every failure given a kind and a plain message:

     unsupported   the browser has no Geolocation API
     insecure      the page is not in a secure context (http:// on a network address)
     denied        the user (or a browser setting) said no
     unavailable   the device could not work out a position
     timeout       no answer in time

   Also: distances (haversine) and "which saved place is this?".
===================================================================== */
"use strict";

(function (P) {
    class GeoError extends Error {
        constructor(kind, message) {
            super(message);
            this.name = "GeoError";
            this.kind = kind;
        }
    }

    const MESSAGES = {
        unsupported: "This browser cannot share a location.",
        insecure: "Location only works on a secure page (https:// or localhost).",
        denied: "Location permission is turned off for this page. Expenses are still saved, just without a place. To turn it on, click the icon at the left of the address bar and allow Location.",
        unavailable: "Your device could not find its position right now (no GPS or Wi-Fi signal). Try again outdoors or later.",
        timeout: "Finding your position took too long. Try again."
    };

    const supported = "geolocation" in navigator;

    /** Current permission state without asking: "granted" | "prompt" | "denied" | "unknown". */
    async function permission() {
        try {
            const status = await navigator.permissions.query({ name: "geolocation" });
            return status;               // has .state and fires "change"
        } catch {
            return { state: "unknown", addEventListener() {} };
        }
    }

    /**
     * Asks for the current position.
     * Resolves { lat, lon, accuracy (m), at (ISO time) }; rejects with a GeoError.
     */
    function locate({ timeout = 10000, maximumAge = 60000, highAccuracy = false } = {}) {
        return new Promise((resolve, reject) => {
            if (!supported) return reject(new GeoError("unsupported", MESSAGES.unsupported));
            if (window.isSecureContext === false) return reject(new GeoError("insecure", MESSAGES.insecure));
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({
                    lat: Number(pos.coords.latitude.toFixed(6)),
                    lon: Number(pos.coords.longitude.toFixed(6)),
                    accuracy: Math.round(pos.coords.accuracy),
                    at: new Date(pos.timestamp || Date.now()).toISOString()
                }),
                (err) => {
                    const kind = { 1: "denied", 2: "unavailable", 3: "timeout" }[err.code] ?? "unavailable";
                    reject(new GeoError(kind, MESSAGES[kind]));
                },
                { timeout, maximumAge, enableHighAccuracy: highAccuracy }
            );
        });
    }

    /** Great-circle distance in km (haversine formula). */
    function distanceKm(a, b) {
        const R = 6371.0088;
        const rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad;
        const dLon = (b.lon - a.lon) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** The closest saved place whose circle contains the point, or null. */
    function placeFor(point, places) {
        let best = null, bestKm = Infinity;
        for (const place of places) {
            const km = distanceKm(point, place);
            if (km * 1000 <= place.radiusM && km < bestKm) { best = place; bestKm = km; }
        }
        return best;
    }

    function formatDistance(km) {
        if (km < 1) return `${Math.round(km * 1000)} m`;
        return `${Number.isInteger(km) || km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
    }

    P.geo = { supported, permission, locate, distanceKm, placeFor, formatDistance, GeoError, MESSAGES };
})(window.Pocket);
