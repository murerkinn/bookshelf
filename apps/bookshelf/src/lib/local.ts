/**
 * `localStorage`, for the things that belong to a device rather than to a
 * profile.
 *
 * Reading positions are the profile's and go to the library; a layout, a zoom
 * and a page tint are properties of the screen being read on, and stay here. So
 * is the browser's copy of a position, which is written before the library's so
 * that a place is never at the mercy of the network.
 *
 * Both calls swallow their failures. Private browsing throws on access rather
 * than returning nothing, and a reader that cannot remember where it was is
 * still a reader — it just starts at the beginning.
 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing is remembered, and nothing else is affected.
  }
}
