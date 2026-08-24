"use client";

import type { BookProgress } from "@bookshelf/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { readStored, writeStored } from "@/lib/local";

/**
 * Keeping a place in a book, from either reader.
 *
 * The awkward parts of this are the same whether a position is a CFI or a page
 * number, so they live here once rather than twice: the browser's copy is
 * written first and the library's is caught up afterwards, the two are
 * reconciled newest-wins on the way in, and the last position of a session is
 * flushed with a beacon because a normal request does not survive the page
 * being closed.
 *
 * What a position *is* stays with the reader that understands it. This only
 * moves it around.
 */

/** A position as a reader reports it; the library sets the timestamp. */
export type ReadingPosition = Omit<BookProgress, "updatedAt">;

/**
 * How long to wait before telling the server where you are.
 *
 * Every page turn moves the position, and a request per turn would cost a read
 * and a write of the progress file each time. Waiting for a pause collapses a
 * chapter's worth of turns into one write, and the browser copy means nothing
 * is at risk while it waits.
 */
const SYNC_DEBOUNCE_MS = 4000;

/** Where this browser remembers a profile's place in a book. */
function progressKey(profileId: string, bookId: string): string {
  return `bookshelf:progress:${profileId}:${bookId}`;
}

function readLocal(key: string): BookProgress | null {
  const raw = readStored(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as BookProgress;
    return typeof parsed?.updatedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, progress: BookProgress): void {
  writeStored(key, JSON.stringify(progress));
}

export type Position = {
  /**
   * False until the browser's copy and the library's have been reconciled. A
   * reader waits for it, so that a book is built once, for the place it is
   * actually going to open at.
   */
  ready: boolean;
  /**
   * The browser's copy as it stands — not as it stood on mount. A reader that
   * rebuilds itself (a change of layout, a change of zoom) asks again and comes
   * back where the reader was, rather than where it started.
   */
  current: () => BookProgress | null;
  /** Records a position: locally at once, and in the library after a pause. */
  record: (position: ReadingPosition) => void;
};

export function useReadingPosition({
  bookId,
  profileId,
  saved,
  canSync,
  legacy,
}: {
  bookId: string;
  profileId: string;
  /** This profile's position as the library has it, from any device. */
  saved: BookProgress | null;
  /** False against a library the app cannot write to. */
  canSync: boolean;
  /**
   * A position this browser stored under an older key, for a reader that has
   * one to migrate. Called only when there is nothing under the current key.
   */
  legacy?: () => BookProgress | null;
}): Position {
  const storageKey = progressKey(profileId, bookId);

  /** A position seen but not yet sent, and the timer that will send it. */
  const pending = useRef<ReadingPosition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sync = useCallback(
    (beacon: boolean) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }

      const position = pending.current;
      if (!position || !canSync) return;
      pending.current = null;

      const body = JSON.stringify({ bookId, ...position });

      // On the way out there is no time for a normal request to finish, and a
      // beacon is the only kind the browser promises to deliver.
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(
          "/api/progress",
          new Blob([body], { type: "application/json" }),
        );
        return;
      }

      void fetch("/api/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // The browser copy is still correct; the next pause tries again.
      });
    },
    [bookId, canSync],
  );

  // Held in a ref so that a reader whose own effects depend on `record` is not
  // torn down and rebuilt every time the migration function is redeclared. Kept
  // up to date in an effect rather than during the render, because a render may
  // be thrown away and a ref written in one would not be.
  const migrate = useRef(legacy);
  useEffect(() => {
    migrate.current = legacy;
  }, [legacy]);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    // The library's copy and this browser's copy are reconciled once, into the
    // browser's, so everything after this reads one place. Newest wins, which
    // is right whichever device was last used — and means a reader that was
    // offline does not lose its place to a stale server copy.
    const local = readLocal(storageKey);
    if (saved && (!local || saved.updatedAt > local.updatedAt)) {
      writeLocal(storageKey, saved);
    } else if (!local) {
      const older = migrate.current?.();
      if (older) writeLocal(storageKey, older);
    }

    setReady(true);
  }, [storageKey, saved]);

  // Leaving the page is the one moment a debounce cannot be allowed to lose.
  useEffect(() => {
    const flush = () => sync(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [sync]);

  const current = useCallback(() => readLocal(storageKey), [storageKey]);

  const record = useCallback(
    (position: ReadingPosition) => {
      // The browser first and without waiting, so the position is never at the
      // mercy of the network; the library catches up once the reader pauses.
      writeLocal(storageKey, {
        ...position,
        updatedAt: new Date().toISOString(),
      });

      pending.current = position;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => sync(false), SYNC_DEBOUNCE_MS);
    },
    [storageKey, sync],
  );

  return { ready, current, record };
}
