import { execFile } from "node:child_process";
import { rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Renders the first page of a document to a PNG at `target`. */
export type Rasteriser = (file: string, target: string) => Promise<void>;

/** Scales an image down, writing whatever format it is named for. */
export type Thumbnailer = {
  /** Including the dot, e.g. `.webp`. */
  extension: string;
  convert: (source: string, target: string, height: number) => Promise<unknown>;
};

async function commandExists(command: string): Promise<boolean> {
  try {
    await run("which", [command]);
    return true;
  } catch {
    return false;
  }
}

let rasteriser: Rasteriser | null | undefined;

export async function findRasteriser(): Promise<Rasteriser | null> {
  if (rasteriser !== undefined) return rasteriser;

  if (await commandExists("pdftoppm")) {
    rasteriser = async (file: string, target: string) => {
      // -singlefile makes it write exactly <base>.png, with no page suffix.
      await run("pdftoppm", [
        "-png",
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        "-r",
        "150",
        file,
        target.replace(/\.png$/, ""),
      ]);
    };
  } else if (await commandExists("sips")) {
    rasteriser = async (file: string, target: string) => {
      await run("sips", ["-s", "format", "png", file, "--out", target]);
    };
  } else if (await commandExists("qlmanage")) {
    rasteriser = async (file: string, target: string) => {
      const directory = path.dirname(target);
      await run("qlmanage", ["-t", "-s", "600", "-o", directory, file]);
      // qlmanage names its output "<original file name>.png".
      await rename(path.join(directory, `${path.basename(file)}.png`), target);
    };
  } else {
    rasteriser = null;
  }

  return rasteriser;
}

/**
 * Covers are published as thumbnails, not originals. A publisher cover is
 * around 1200x1574 and near a megabyte, while the shelf renders it into a
 * 40x60 slot — roughly a hundred times more image than the page can show.
 */
let thumbnailer: Thumbnailer | null | undefined;

export async function findThumbnailer(): Promise<Thumbnailer | null> {
  if (thumbnailer !== undefined) return thumbnailer;

  if (await commandExists("cwebp")) {
    thumbnailer = {
      extension: ".webp",
      convert: (source: string, target: string, height: number) =>
        // Width 0 tells cwebp to preserve the aspect ratio.
        run("cwebp", [
          "-quiet",
          "-q",
          "78",
          "-resize",
          "0",
          String(height),
          source,
          "-o",
          target,
        ]),
    };
  } else if (await commandExists("sips")) {
    // sips on this platform writes a zero-byte file when asked for WebP, so
    // JPEG is the fallback. Still ~50x smaller than the original.
    thumbnailer = {
      extension: ".jpg",
      convert: (source: string, target: string, height: number) =>
        run("sips", [
          "-Z",
          String(height),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80",
          source,
          "--out",
          target,
        ]),
    };
  } else {
    thumbnailer = null;
  }

  return thumbnailer;
}
