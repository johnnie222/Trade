/**
 * Action and input registries.
 *
 * These live in their own module with no imports, on purpose.
 *
 * app.js imports the screens; the screens need somewhere to register their
 * handlers. If that somewhere were app.js, the screen module bodies would run
 * during app.js's own import phase — before its `const` declarations are
 * initialised — and every screen would throw on load. A leaf module both sides
 * import breaks the cycle.
 */

/** data-action="name" → handler(element, event) */
export const ACTIONS = {};

/** data-live="name" → handler(element) on input */
export const LIVE = {};
