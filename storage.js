/* Image storage. Local disk by default; Cloudflare R2 if the env vars exist.
 * Nothing here needs configuring to run. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

export const LOCAL_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(LOCAL_DIR, { recursive: true });

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
const FOLDER = process.env.CLOUDINARY_FOLDER || 'seweaves';

export const usingCloudinary = Boolean(CLOUD && CLOUD_KEY && CLOUD_SECRET);

export const usingR2 = !usingCloudinary && Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_URL
);

/* ---------------------------- Cloudinary ----------------------------
 * Signed uploads: the secret stays on the server. Cloudinary wants the
 * signable params sorted, joined, secret appended, then SHA-1.
 * -------------------------------------------------------------------- */
function sign(params) {
  const base = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(base + CLOUD_SECRET).digest('hex');
}

const publicIdFor = key => `${FOLDER}/${key.replace(/\.[a-z0-9]+$/i, '')}`;

async function cloudinaryPut(key, body, contentType) {
  const timestamp = Math.floor(Date.now() / 1000);
  const public_id = publicIdFor(key);

  const form = new FormData();
  form.append('file', new Blob([body], { type: contentType }), key);
  form.append('api_key', CLOUD_KEY);
  form.append('timestamp', String(timestamp));
  form.append('public_id', public_id);
  form.append('overwrite', 'true');
  form.append('signature', sign({ public_id, timestamp, overwrite: 'true' }));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, {
    method: 'POST', body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Cloudinary refused the upload (${res.status}).`);
  return data.secure_url;
}

async function cloudinaryRemove(url) {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i);
  if (!match) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const public_id = match[1];

  const form = new FormData();
  form.append('api_key', CLOUD_KEY);
  form.append('timestamp', String(timestamp));
  form.append('public_id', public_id);
  form.append('signature', sign({ public_id, timestamp }));

  await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`, {
    method: 'POST', body: form
  });
}

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
  if (usingCloudinary) return cloudinaryPut(key, body, contentType);
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
    if (!url) return;
    if (usingCloudinary) return cloudinaryRemove(url);
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
  if (usingCloudinary) return `Cloudinary (${CLOUD}/${FOLDER}) — photos survive restarts`;
  return usingR2
    ? `Cloudflare R2 (${process.env.R2_BUCKET}) — photos survive restarts`
    : `local disk ${LOCAL_DIR} — photos are lost when the host restarts`;
}
