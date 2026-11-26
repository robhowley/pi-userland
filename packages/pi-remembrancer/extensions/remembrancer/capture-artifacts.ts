import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureReview, type PreparedCapturePage } from './capture-review.js';
import { REVIEW_RESPONSE_MAX_BYTES } from './review-pages.js';

export const REMEMBRANCER_SKILL_PATH = fileURLToPath(
  new URL('../../skills/remembrancer/SKILL.md', import.meta.url),
);

export type CaptureArtifactRead = Readonly<{
  text: string;
  /** Host only, after the reviewer accepts this complete text and its budget. */
  accept(): void;
}>;

/** One attempt's generated evidence. The installed skill is read directly, never owned here. */
export class CaptureArtifacts {
  readonly reviewPath: string;
  readonly skillPath = REMEMBRANCER_SKILL_PATH;
  readonly pageCount: number;
  private readonly directory: string;
  private directoryIdentity: { dev: number; ino: number } | undefined;
  private readonly pages: PreparedCapturePage[];
  private readonly bytes: Buffer;
  private fd: number | undefined;
  private fileCreated = false;
  private closed = false;
  private skillDelivered = false;

  constructor(private readonly review: CaptureReview) {
    // Missing/unreadable or oversized installed guidance prevents startup. Do not retain it.
    this.readSkill();
    this.pages = [...review.preparePages()];
    this.pageCount = this.pages.length;
    this.bytes = Buffer.from(this.pages.map((page) => page.text + '\n').join(''), 'utf8');
    this.directory = mkdtempSync(join(tmpdir(), 'remembrancer-review-'));
    this.reviewPath = join(this.directory, 'review.jsonl');
    try {
      this.directoryIdentity = lstatSync(this.directory);
      chmodSync(this.directory, 0o700);
      this.fd = openSync(
        this.reviewPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      this.fileCreated = true;
      if (!fstatSync(this.fd).isFile()) throw new Error('Capture evidence is not a regular file.');
      writeFileSync(this.fd, this.bytes);
      this.assertGenerated();
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Capture artifact preparation and cleanup failed.',
        );
      }
      throw error;
    }
  }

  /** Exact paths only. Evidence pages are zero-based, next-in-order or accepted-page rereads. */
  read(path: string, page = 0): CaptureArtifactRead {
    this.assertOpen();
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid capture artifact page.');
    if (path === this.skillPath) {
      if (page !== 0) throw new Error('Read the complete installed skill as page zero.');
      const text = this.readSkill();
      return Object.freeze({
        text,
        accept: () => {
          this.assertOpen();
          this.skillDelivered = true;
        },
      });
    }
    if (path !== this.reviewPath) throw new Error('Path is not an allowed capture artifact.');
    this.assertSkillDelivered();
    const prepared = this.pages[page];
    if (!prepared) throw new Error('Invalid capture evidence page.');
    prepared.assertReadable();
    this.assertGenerated();
    return Object.freeze({
      text: prepared.text,
      accept: () => {
        this.assertOpen();
        this.assertGenerated();
        prepared.accept();
      },
    });
  }

  assertDelivered(): void {
    this.assertOpen();
    this.assertSkillDelivered();
    this.readSkill();
    this.assertGenerated();
    this.review.assertEvidenceDelivered();
  }

  /** Always attempt every cleanup operation. A failure must prevent publication. */
  dispose(): void {
    this.closed = true;
    const errors: unknown[] = [];
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
        this.fd = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    // Do not recursively remove anything, and never traverse a replaced attempt directory.
    try {
      const directory = lstatSync(this.directory);
      if (
        !directory.isDirectory() ||
        (this.directoryIdentity &&
          (directory.dev !== this.directoryIdentity.dev ||
            directory.ino !== this.directoryIdentity.ino))
      )
        throw new Error('Capture artifact directory changed before cleanup.');
      if (this.fileCreated) {
        try {
          unlinkSync(this.reviewPath);
          this.fileCreated = false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
        }
      }
      try {
        rmdirSync(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Capture artifact cleanup failed.');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Capture artifacts are closed.');
  }

  /** Guard every other reviewer-facing lookup with this, not only evidence reads. */
  assertSkillDelivered(): void {
    this.assertOpen();
    if (!this.skillDelivered)
      throw new Error('Read and accept the complete installed skill first.');
  }

  private readSkill(): string {
    const text = readFileSync(this.skillPath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > REVIEW_RESPONSE_MAX_BYTES)
      throw new Error('The complete installed skill exceeds the capture read limit.');
    return text;
  }

  private assertGenerated(): void {
    this.assertOpen();
    if (this.fd === undefined) throw new Error('Capture evidence descriptor is closed.');
    const directory = lstatSync(this.directory);
    const file = lstatSync(this.reviewPath);
    const retained = fstatSync(this.fd);
    if (
      !this.directoryIdentity ||
      !directory.isDirectory() ||
      directory.dev !== this.directoryIdentity.dev ||
      directory.ino !== this.directoryIdentity.ino ||
      !file.isFile() ||
      !retained.isFile() ||
      file.dev !== retained.dev ||
      file.ino !== retained.ino ||
      retained.size !== this.bytes.length
    )
      throw new Error('Capture evidence file changed.');
    const chunk = Buffer.alloc(Math.min(64 * 1024, this.bytes.length));
    let offset = 0;
    while (offset < this.bytes.length) {
      const count = readSync(
        this.fd,
        chunk,
        0,
        Math.min(chunk.length, this.bytes.length - offset),
        offset,
      );
      if (!count || !chunk.subarray(0, count).equals(this.bytes.subarray(offset, offset + count)))
        throw new Error('Capture evidence bytes changed.');
      offset += count;
    }
    if (fstatSync(this.fd).size !== this.bytes.length)
      throw new Error('Capture evidence file changed.');
  }
}
