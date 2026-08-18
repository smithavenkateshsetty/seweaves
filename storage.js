/* Image storage. Local disk by default; Cloudflare R2 if the env vars exist.
 * Nothing here needs configuring to run. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

export const LOCAL_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(LOCAL_DIR, { recursive: true });

export const usingR2 = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_URL
);

let client = null;
async function r2() {
  if (client) return client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  return client;
}

export async function put(key, body, contentType = 'image/webp') {
  if (!usingR2) {
    await fs.promises.writeFile(path.join(LOCAL_DIR, key), body);
    return `/uploads/${key}`;
  }
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await r2()).send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: key, Body: body, ContentType: contentType
  }));
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}

export async function remove(url) {
  try {
    if (!usingR2) {
      if (!url?.startsWith('/uploads/')) return;
      await fs.promises.unlink(path.join(LOCAL_DIR, path.basename(url)));
      return;
    }
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await r2()).send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET, Key: url.split('/').pop()
    }));
  } catch { /* a missing file is not worth failing the request over */ }
}

export function describeStorage() {
  return usingR2
    ? `Cloudflare R2 (${process.env.R2_BUCKET}) — photos survive restarts`
    : `local disk ${LOCAL_DIR} — photos are lost when the host restarts`;
}
