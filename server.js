// server.js — MultiClip API (ESM)

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- CORS: * 또는 화이트리스트 ---------- */
const rawOrigins = (process.env.CORS_ORIGIN || '*').trim();
const allowAll = rawOrigins === '' || rawOrigins === '*';
const originList = allowAll ? [] : rawOrigins.split(',').map(s => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (allowAll) return cb(null, true);
      if (!origin) return cb(null, true);                 // same-origin / server-to-server
      if (originList.includes(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
    credentials: false,
  })
);
app.options('*', cors());

/* ---------- 정적 파일 서빙: public/ ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 예: https://<host>/multiclip-test.html 로 접근
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- AWS S3 ---------- */
const region = process.env.AWS_REGION || 'us-east-1';
const bucket = process.env.S3_BUCKET;
const urlTtlSec = Number(process.env.SIGNED_URL_TTL_SEC || 300);
const s3 = new S3Client({ region });

/* ---------- 인메모리 잡 저장소 ---------- */
const jobs = new Map();
const nid = (p = 'job') => `${p}_${crypto.randomBytes(8).toString('hex')}`;

/* ---------- 라우트 ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/parse', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ code: 'BAD_URL', message: '유효한 URL을 입력하세요.' });
  }
  let platform = 'youtube';
  if (/tiktok\./i.test(url)) platform = 'tiktok';
  else if (/instagram\./i.test(url)) platform = 'instagram';
  else if (/facebook\.|fb\.watch/i.test(url)) platform = 'facebook';
  const resourceId = nid('rs');
  res.json({ platform, resourceId });
});

app.post('/api/download', (req, res) => {
  const { platform, resourceId, quality = '720p', type = 'video' } = req.body || {};
  if (!platform || !resourceId) {
    return res.status(400).json({ code: 'BAD_REQ', message: 'platform 및 resourceId 필요' });
  }
  const jobId = nid('job');
  jobs.set(jobId, { status: 'queued', progress: 0, platform, resourceId, quality, type });

  simulateWorker(jobId).catch(err => {
    jobs.set(jobId, { status: 'error', progress: 0, error: String(err?.message || err) });
  });

  res.json({ jobId, estimatedSec: 10 });
});

app.get('/api/download/status', (req, res) => {
  const { jobId } = req.query || {};
  const job = jobs.get(String(jobId));
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  res.json({ jobId, ...job });
});

/* ---------- 작업 시뮬레이터 (S3 업로드 후 서명 URL 발급) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function simulateWorker(jobId) {
  if (!bucket) throw new Error('S3_BUCKET 환경 변수가 설정되지 않았습니다.');

  const key = `tmp/${jobId}.txt`;
  const body = Buffer.from(`job:${jobId} - sample content`);

  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));

  for (let p = 0; p <= 100; p += 20) {
    await sleep(400);
    let downloadUrl;
    if (p >= 100) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      downloadUrl = await getSignedUrl(s3, cmd, { expiresIn: urlTtlSec });
    }
    jobs.set(jobId, { status: p < 100 ? 'processing' : 'done', progress: p, downloadUrl });
  }
}

/* ---------- 서버 시작 ---------- */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
