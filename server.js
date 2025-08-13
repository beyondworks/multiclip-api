import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Load variables from .env if present
dotenv.config();

const app = express();
app.use(express.json());

// CORS origins: comma-separated list in env or allow all
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins === '*' || !allowedOrigins.length ? '*' : allowedOrigins,
  })
);

// AWS S3 setup
const region = process.env.AWS_REGION || 'us-east-1';
const bucket = process.env.S3_BUCKET;
const urlTtlSec = Number(process.env.SIGNED_URL_TTL_SEC || 300);

const s3 = new S3Client({ region });

// In-memory job store (use DB/Redis in production)
const jobs = new Map();

/**
 * Generate a new random ID
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix = 'job') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/parse', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ code: 'BAD_URL', message: '유효한 URL을 입력하세요.' });
  }
  let platform = 'youtube';
  if (/tiktok\./i.test(url)) platform = 'tiktok';
  else if (/instagram\./i.test(url)) platform = 'instagram';
  else if (/facebook\.|fb\.watch/i.test(url)) platform = 'facebook';
  const resourceId = newId('rs');
  res.json({ platform, resourceId });
});

app.post('/api/download', (req, res) => {
  const { platform, resourceId, quality = '720p', type = 'video' } = req.body || {};
  if (!platform || !resourceId) {
    return res.status(400).json({ code: 'BAD_REQ', message: 'platform 및 resourceId 필요' });
  }
  const jobId = newId('job');
  jobs.set(jobId, { status: 'queued', progress: 0, platform, resourceId, quality, type });
  simulateWorker(jobId).catch((err) => {
    jobs.set(jobId, { status: 'error', progress: 0, error: String(err) });
  });
  res.json({ jobId, estimatedSec: 10 });
});

app.get('/api/download/status', (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  res.json({ jobId, ...job });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateWorker(jobId) {
  if (!bucket) throw new Error('S3_BUCKET 환경 변수가 설정되지 않았습니다.');
  // Upload a small file to S3 as a placeholder
  const key = `tmp/${jobId}.txt`;
  const body = Buffer.from(`job:${jobId} - sample content`);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  for (let progress = 0; progress <= 100; progress += 20) {
    await sleep(400);
    let url;
    if (progress >= 100) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      url = await getSignedUrl(s3, cmd, { expiresIn: urlTtlSec });
    }
    jobs.set(jobId, {
      status: progress < 100 ? 'processing' : 'done',
      progress,
      downloadUrl: url,
    });
  }
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});