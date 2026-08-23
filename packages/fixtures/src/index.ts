/**
 * Generated books, archives and documents.
 *
 * Everything a test or the demo shelf needs to have a real file to work on,
 * built rather than downloaded — which matters for more than convenience. A
 * fixture with no network dependency behaves the same in CI, on a plane, and in
 * five years when whatever it was fetched from has reorganised its URLs.
 *
 * A package rather than a directory beside the tests, because the tests live
 * with the code they exercise now, and several packages need the same
 * generators. `npm run demo` builds its shelf out of the same ones, which is
 * the other reason these are not test-only.
 */
export type { BookSpec, Rgb } from "./epub.js";
export { coverArt, epub, png } from "./epub.js";
export type { BytesLike, PdfSpec } from "./pdf.js";
export {
  brokenXrefPdf,
  classicPdf,
  literal,
  objectStreamPdf,
  pdfDocEncoded,
  shiftedPdf,
  utf16,
  xmpPacket,
} from "./pdf.js";
export type { DemoBook } from "./shelf.js";
export { BOOKS, writeBooks } from "./shelf.js";
export type { ZipEntryInput, ZipOptions } from "./zip.js";
export { crc32, digest, writeZip } from "./zip.js";
