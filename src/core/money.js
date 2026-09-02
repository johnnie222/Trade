/**
 * Money and rounding helpers.
 *
 * Internal arithmetic runs in float64. Weighted average cost is inherently
 * fractional, so rounding to cents mid-calculation would introduce drift that
 * compounds over adds and trims. Instead: never round while accumulating,
 * round only at the display boundary.
 *
 * EPS exists because stop comparisons must not flip on float noise.
 * 1e-9 is far below one cent and far above float64 error at these magnitudes.
 */

export const EPS = 1e-9;

/** Round to cents. Display boundary only. */
export function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round an R multiple to 2dp. Display boundary only. */
export function rMultiple(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round a share count. Fractional shares are not supported. */
export function shares(n) {
  return Math.round(n);
}

export function gte(a, b) {
  return a - b > -EPS;
}

export function lte(a, b) {
  return a - b < EPS;
}

export function eq(a, b) {
  return Math.abs(a - b) < EPS;
}
