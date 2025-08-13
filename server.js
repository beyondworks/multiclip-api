import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
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
    if (!origin) return cb(null, true); // same-origin
    if (originList.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
}));
app.options('*', cors());

/* ---------- 정적 ---------- */
app.use(express.static('public'));

/* ---------- S3 ---------- */
const region = process.env.AWS_REGION || 'us-east-1';
const bucket =
  process.env.S3_BUCKET ||
  process.env.AWS_BUCKET_NAME ||
  process.env.S3_BUCKET_NAME;

const urlTtlSec = Number(process.env.SIGNED_URL_TTL_SEC || 900); // 15분

if (!bucket) console.warn('[WARN] S3 bucket env not set (S3_BUCKET)');

const s3 = new S3Client({ region });

/* ---------- 잡/히스토리 ---------- */
const jobs = new Map();
const history = [];
const MAX_HISTORY = 50;
const nid = (p = 'job') => `${p}_${crypto.randomBytes(8).toString('hex')}`;

function pushHistory(item) {
  history.unshift({ ...item, at: Date.now() });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 헬스 ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- 파비콘(404 방지) ---------- */
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/* ---------- 최근 작업 ---------- */
app.get('/api/history', (_req, res) => {
  res.json({ items: history });
});

/* ---------- URL 파싱 (플랫폼 감지만) ---------- */
app.post('/api/parse', (req, res) => {
  try {
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
  } catch (e) {
    console.error('[parse] error:', e);
    return res.status(500).json({ code: 'PARSE_FAIL', message: String(e) });
  }
});

/* ---------- 다운로드 잡 생성 ---------- */
app.post('/api/download', (req, res) => {
  try {
    const { url, platform, resourceId, quality = '1080p', type = 'video' } = req.body || {};
    if (!url || !platform || !resourceId) {
      return res.status(400).json({ code: 'BAD_REQ', message: 'url, platform, resourceId가 필요합니다.' });
    }
    const jobId = nid('job');
    const payload = { status: 'queued', progress: 0, platform, resourceId, quality, type, url };
    jobs.set(jobId, payload);

    // 비동기 워커 시작 (응답과 분리)
    runWorker(jobId).catch(err => {
      const em = String(err?.stderr || err?.message || err);
      const failed = { ...payload, status: 'error', progress: 0, error: em };
      jobs.set(jobId, failed);
      pushHistory({ jobId, ...failed });
      console.error('[worker] failed:', em);
    });

    return res.json({ jobId, estimatedSec: 20 });
  } catch (e) {
    console.error('[download] handler error:', e);
    return res.status(500).json({ code: 'REQ_FAIL', message: String(e) });
  }
});

/* ---------- 다운로드 상태 ---------- */
app.get('/api/download/status', (req, res) => {
  const { jobId } = req.query || {};
  const job = jobs.get(String(jobId));
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  return res.json({ jobId, ...job });
});

/* ---------- 워커: yt-dlp로 mp4/m4a 받고 S3 업로드 ---------- */
async function runWorker(jobId) {
  if (!bucket) throw new Error('S3_BUCKET 환경 변수가 설정되지 않았습니다.');
  const cur = jobs.get(jobId);
  if (!cur) return;

  const { url, quality, type = 'video' } = cur;
  jobs.set(jobId, { ...cur, status: 'processing', progress: 5 });

  const audioOnly = String(type).toLowerCase() === 'audio';
  const tmpFile = tmp.tmpNameSync({ postfix: audioOnly ? '.m4a' : '.mp4' });

  try {
    // format 결정
    let fmt;
    if (audioOnly) {
      fmt = 'bestaudio[ext=m4a]/bestaudio';
    } else {
      fmt =
        quality === '4K'
          ? 'bestvideo[height>=2160][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
          : quality === '1080p'
          ? 'bestvideo[height>=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
          : 'bestvideo[height>=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    }

    jobs.set(jobId, { ...jobs.get(jobId), progress: 15 });

    // yt-dlp 실행
    await ytdlp(url, {
      output: tmpFile,
      format: fmt,
      mergeOutputFormat: audioOnly ? 'm4a' : 'mp4',
      ffmpegLocation: ffmpegPath || undefined,
      retries: 3,
      noCheckCertificates: true
    });

    const stat = await fs.stat(tmpFile);
    const fileSize = stat?.size || 0;
    if (!fileSize) throw new Error('다운로드된 파일이 비어 있습니다.');

    jobs.set(jobId, { ...jobs.get(jobId), progress: 60 });

    const ext = audioOnly ? 'm4a' : 'mp4';
    const key = `downloads/${jobId}.${ext}`;
    const body = fs.createReadStream(tmpFile);

    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: audioOnly ? 'audio/mp4' : 'video/mp4'
      },
      queueSize: 3,
      partSize: 8 * 1024 * 1024
    });

    uploader.on('httpUploadProgress', (p) => {
      const ratio = p.total ? Math.round((p.loaded / p.total) * 30) : 0;
      jobs.set(jobId, { ...jobs.get(jobId), progress: 60 + Math.min(30, ratio) });
    });

    await uploader.done();

    const signed = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: urlTtlSec }
    );

    const result = {
      ...jobs.get(jobId),
      status: 'done',
      progress: 100,
      downloadUrl: signed,
      fileKey: key,
      fileSize
    };
    jobs.set(jobId, result);
    pushHistory({ jobId, ...result });
  } catch (err) {
    const em = String(err?.stderr || err?.message || err);
    const failed = { ...jobs.get(jobId), status: 'error', progress: 0, error: em };
    jobs.set(jobId, failed);
    pushHistory({ jobId, ...failed });
    console.error('[worker] error:', em);
  } finally {
    try { await fs.remove(tmpFile); } catch {}
  }
}

/* ---------- 전역 에러 로깅 (502 추적용) ---------- */
process.on('unhandledRejection', (r) => {
  console.error('[unhandledRejection]', r);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
});

/* ---------- 서버 시작 ---------- */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log(`[CORS] CORS_ORIGIN="${rawOrigins}" allowAll=${allowAll} list=${JSON.stringify(originList)}`);
});
