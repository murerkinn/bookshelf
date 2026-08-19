import { execFile } from "node:child_process";
import { rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function commandExists(command) {
  try {
    await run("which", [command]);
    return true;
  } catch {
    return false;
  }
}

let rasteriser;
export async function findRasteriser() {
  if (rasteriser !== undefined) return rasteriser;

  if (await commandExists("pdftoppm")) {
    rasteriser = async (file, target) => {
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
    rasteriser = async (file, target) => {
      await run("sips", ["-s", "format", "png", file, "--out", target]);
    };
  } else if (await commandExists("qlmanage")) {
    rasteriser = async (file, target) => {
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
let thumbnailer;
export async function findThumbnailer() {
  if (thumbnailer !== undefined) return thumbnailer;

  if (await commandExists("cwebp")) {
    thumbnailer = {
      extension: ".webp",
      convert: (source, target, height) =>
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
      convert: (source, target, height) =>
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
