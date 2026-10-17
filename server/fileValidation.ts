import { MAX_JOB_FILE_BYTES } from '../src/data/shopContract.ts';
import type { JobFileKind, JobFileMediaType } from '../src/data/shopContract.ts';

export interface JobFileInput {
  kind: JobFileKind;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  note?: string;
}
export interface ValidatedJobFile extends JobFileInput { mediaType: JobFileMediaType }

export class FileValidationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message); this.code = code; this.status = status;
  }
}
const invalid = (message: string): never => { throw new FileValidationError('INVALID_FILE', 400, message); };
const bytesMatch = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => signature.every((value, index) => bytes[offset + index] === value);

function hasSignature(bytes: Uint8Array, mediaType: JobFileMediaType): boolean {
  if (mediaType === 'application/pdf') {
    const header = Buffer.from(bytes.subarray(0, 9)).toString('ascii');
    const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1');
    return /^%PDF-[12]\.\d(?:\r|\n|\s)/.test(header) && /%%EOF[\t\r\n ]*$/.test(tail);
  }
  if (mediaType === 'image/jpeg') return bytes.length >= 8 && bytesMatch(bytes, [0xff, 0xd8, 0xff]) && bytesMatch(bytes, [0xff, 0xd9], bytes.length - 2);
  if (bytes.length < 45 || !bytesMatch(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !bytesMatch(bytes, [73, 72, 68, 82], 12) || view.getUint32(16) === 0 || view.getUint32(20) === 0) return false;
  return bytesMatch(bytes, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], bytes.length - 12);
}

/** Content identification only; print-readiness checks need the actual prepress tools. */
export function validateJobFile(input: JobFileInput): ValidatedJobFile {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['kind', 'filename', 'mediaType', 'bytes', 'note'].includes(key))) return invalid('Invalid file fields.');
  if (input.kind !== 'artwork' && input.kind !== 'proof') return invalid('Unknown file kind.');
  if (typeof input.filename !== 'string') return invalid('A filename is required.');
  const filename = input.filename.normalize('NFC').trim();
  if (!filename || filename.length > 180 || /[\p{Cc}\p{Cf}/\\]/u.test(filename) || filename === '.' || filename === '..') return invalid('Use a filename without paths or special control characters.');
  if (typeof input.mediaType !== 'string' || !['application/pdf', 'image/png', 'image/jpeg'].includes(input.mediaType)) return invalid('Use a PDF, PNG or JPEG file.');
  const mediaType = input.mediaType as JobFileMediaType;
  const extension = filename.split('.').at(-1)!.toLowerCase();
  if (!(mediaType === 'application/pdf' ? extension === 'pdf' : mediaType === 'image/png' ? extension === 'png' : extension === 'jpg' || extension === 'jpeg')) return invalid('The file extension does not match its type.');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) return invalid('The file is empty.');
  if (input.bytes.byteLength > MAX_JOB_FILE_BYTES) throw new FileValidationError('FILE_TOO_LARGE', 413, 'The file exceeds 10 MiB.');
  const bytes = new Uint8Array(input.bytes);
  if (!hasSignature(bytes, mediaType)) return invalid('The file content does not match its type.');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.note))) return invalid('Invalid proof note.');
  return { kind: input.kind, filename, mediaType, bytes, ...(input.note === undefined ? {} : { note: input.note.trim() }) };
}
