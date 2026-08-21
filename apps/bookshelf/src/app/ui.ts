/**
 * The app's shared control styles, in the Apple idiom: pill-shaped buttons
 * shaped by fills rather than borders or shadows, one accent color for the
 * primary action on a screen, and quiet text buttons for everything minor.
 */

/** The one thing to do on this screen: a filled accent pill. */
export const BUTTON_PRIMARY =
  "rounded-full bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover";

/** A normal action: a gray-fill pill that darkens on hover. */
export const BUTTON =
  "rounded-full bg-fill px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-fill-hover";

/** A minor action: just text until hovered. */
export const BUTTON_QUIET =
  "rounded-full px-3 py-1.5 text-sm font-medium text-secondary transition-colors hover:bg-fill hover:text-foreground";

/** Text fields: a fill instead of a border, and the accent only on focus. */
export const INPUT =
  "rounded-lg bg-fill px-3 py-1.5 text-sm outline-none transition-shadow placeholder:text-tertiary focus:ring-2 focus:ring-accent";
