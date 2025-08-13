import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import tmp from 'tmp';
import ytdlp from 'yt-dlp-exec';
import ffmpegPath from 'ffmpeg-static';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------- CORS ---------- */
const rawOrigins = (process.env.CORS_ORIGIN || '*').trim();
const allowAll = rawOrigins === '' || rawOrigins === '*';
const originList = allowAll ? [] : rawOrigins.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (allowAll) return cb(null, true);
    if (!origin) return cb(null, true);          // same-origin
    if (originList.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
}));
app.options('*', cors());

/* ---------- 정적 ---------- */
app.use(express.static('public'));

/* ---------- S3 ---------- */
const region = process.env.AWS_REGION || 'us-east-1';
const bucket = process.env.S3_BUCKET || process.env.AWS_BUCKET_NAME || process.env.S3_BUCKET_NAME;
const urlTtlSec = Number(process.env.SIGNED_URL_TTL_SEC || 900); // 권장 15분
if (!bucket) console.warn('[WARN] S3 bucket env not set (S3_BUCKET)');

const s3 = new S3Client({ region });

/* ---------- 잡 저장소 ---------- */
const jobs = new Map();
const nid = (p='job') => `${p}_${crypto.randomBytes(8).toString('hex')}`;

app.get('/health', (_req, res) => res.json({ ok: true }));

/* URL 파싱(플랫폼 감지만) */
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
  return res.json({ platform, resourceId });
});

/* 다운로드 잡 생성 */
app.post('/api/download', async (req, res) => {
  const { url, platform, resourceId, quality = '1080p', type = 'video' } = req.body || {};
  if (!url || !platform || !resourceId) {
    return res.status(400).json({ code: 'BAD_REQ', message: 'url, platform, resourceId가 필요합니다.' });
  }
  const jobId = nid('job');
  jobs.set(jobId, { status: 'queued', progress: 0, platform, resourceId, quality, type, url });
  runWorker(jobId).catch(err => {
    jobs.set(jobId, { status: 'error', progress: 0, error: String(err?.message || err) });
  });
  res.json({ jobId, estimatedSec: 20 });
});

/* 다운로드 상태 조회 */
app.get('/api/download/status', (req, res) => {
  const { jobId } = req.query || {};
  const job = jobs.get(String(jobId));
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  return res.json({ jobId, ...job });
});

/* ---------- 워커: yt-dlp로 mp4 받고 S3 업로드 ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runWorker(jobId) {
  if (!bucket) throw new Error('S3_BUCKET 환경 변수가 설정되지 않았습니다.');
  const job = jobs.get(jobId);
  if (!job) return;
  const { url, quality } = job;

  jobs.set(jobId, { ...job, status: 'processing', progress: 5 });

  // 임시 파일 경로 생성
  const tmpFile = tmp.tmpNameSync({ postfix: '.mp4' });

  try {
    // 품질 프리셋 → yt-dlp format 문자열
    const fmt = quality === '4K'
      ? 'bestvideo[height>=2160][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : quality === '1080p'
      ? 'bestvideo[height>=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : 'bestvideo[height>=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

    // yt-dlp 실행 (ffmpeg-static 경로 지정)
    jobs.set(jobId, { ...job, status: 'processing', progress: 20 });
    await ytdlp(url, {
      output: tmpFile,
      format: fmt,
      mergeOutputFormat: 'mp4',
      ffmpegLocation: ffmpegPath || undefined,
      // 안정 옵션
      retries: 3,
      noCheckCertificates: true,
      preferFreeFormats: false,
      // quiet: true  // 필요 시 로그 억제
    });

    // 파일 존재/사이즈 확인
    const stat = await fs.stat(tmpFile);
    if (!stat || stat.size === 0) throw new Error('다운로드된 파일이 비어 있습니다.');

    jobs.set(jobId, { ...job, status: 'processing', progress: 60 });

    // S3 업로드 (스트리밍)
    const key = `downloads/${jobId}.mp4`;
    const body = fs.createReadStream(tmpFile);

    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'video/mp4',
        // 원하면 공개 링크로: ACL: 'public-read'
      },
      queueSize: 3,
      partSize: 8 * 1024 * 1024
    });

    uploader.on('httpUploadProgress', (p) => {
      const ratio = p.total ? Math.round((p.loaded / p.total) * 30) : 0; // 업로드 구간 60→90 사이
      jobs.set(jobId, { ...jobs.get(jobId), progress: 60 + Math.min(30, ratio) });
    });

    await uploader.done();

    jobs.set(jobId, { ...jobs.get(jobId), progress: 95 });

    // 서명 URL 발급
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const downloadUrl = await getSignedUrl(s3, cmd, { expiresIn: urlTtlSec });

    jobs.set(jobId, { ...jobs.get(jobId), status: 'done', progress: 100, downloadUrl });
  } catch (err) {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'error', progress: 0, error: String(err?.stderr || err?.message || err) });
  } finally {
    // 임시 파일 정리
    try { await fs.remove(tmpFile); } catch {}
  }
}

/* ---------- 서버 시작 ---------- */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log(`[CORS] CORS_ORIGIN="${rawOrigins}" allowAll=${allowAll} list=${JSON.stringify(originList)}`);
});
