import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { spawn } from 'node:child_process';
import { Upload } from '@aws-sdk/lib-storage';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const limiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(limiter);

const ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb)=> cb(null, !origin || ORIGINS.length===0 || ORIGINS.includes(origin)), credentials: false }));

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET;
const URL_TTL = Number(process.env.SIGNED_URL_TTL_SEC || 300);

// 인메모리 작업 상태 저장 (초기 MVP)
const jobs = new Map();

app.get('/health', (req,res)=> res.json({ ok: true }));

// 간단 parse: yt-dlp -j 로 메타만 조회
app.post('/api/parse', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid url' });

    const out = await runYtDlpJson(url);
    const platform = detectPlatform(url, out?.extractor_key);
    const resourceId = out?.id || nanoid(8);
    res.json({ platform, resourceId, title: out?.title || '' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/download', async (req, res) => {
  const { url, quality='720p', type='video' } = req.body || {};
  const src = url;
  if (!src || !/^https?:\/\//i.test(src)) return res.status(400).json({ error: 'missing url' });

  const jobId = `job_${nanoid(10)}`;
  jobs.set(jobId, { status: 'queued', progress: 0 });
  res.json({ jobId });

  // 비동기 작업 시작
  downloadAndUpload({ jobId, src, quality, type }).catch(err => {
    jobs.set(jobId, { status: 'error', progress: 0, error: String(err?.message || err) });
  });
});

app.get('/api/download/status', async (req, res) => {
  const { jobId } = req.query;
  const st = jobs.get(String(jobId));
  if (!st) return res.status(404).json({ error: 'not found' });
  res.json(st);
});

// ==== helpers ====
function detectPlatform(url, extractorKey){
  if (extractorKey) return String(extractorKey).toLowerCase();
  if (/youtu\.be|youtube\.com/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/facebook\.com/.test(url)) return 'facebook';
  return 'unknown';
}

async function runYtDlpJson(url){
  return new Promise((resolve, reject)=>{
    const ps = spawn('yt-dlp', ['-j', url]);
    let out=''; let err='';
    ps.stdout.on('data', d=> out += d.toString());
    ps.stderr.on('data', d=> err += d.toString());
    ps.on('close', code=>{
      if (code===0) {
        try { resolve(JSON.parse(out)); } catch(e){ reject(new Error('parse fail')); }
      } else reject(new Error(err || `yt-dlp exit ${code}`));
    });
    ps.on('error', reject);
  });
}

async function downloadAndUpload({ jobId, src, quality, type }){
  jobs.set(jobId, { status: 'processing', progress: 5 });

  const key = `tmp/${jobId}.${type==='audio' ? 'm4a' : 'mp4'}`;
  const contentType = type==='audio' ? 'audio/mp4' : 'video/mp4';

  // 포맷 선택
  const format = type==='audio'
    ? 'bestaudio[ext=m4a]/bestaudio'
    : (quality==='4k' ? 'bestvideo[height>=2160][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
       : quality==='1080p' ? 'bestvideo[height>=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
       : 'best[ext=mp4]/best');

  const args = ['-f', format, '-o', '-', '--merge-output-format', type==='audio'?'m4a':'mp4', src];
  const ps = spawn('yt-dlp', args);

  const uploader = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: ps.stdout, ContentType: contentType }
  });

  ps.stderr.on('data', () => {
    const cur = jobs.get(jobId)?.progress ?? 10;
    if (cur < 90) jobs.set(jobId, { status: 'processing', progress: cur + 1 });
  });

  await uploader.done();
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_TTL });
  jobs.set(jobId, { status: 'done', progress: 100, downloadUrl: url });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`listening on ${PORT}`));
