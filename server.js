import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import ytdl from 'ytdl-core';

// .env 로드
dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

/* --------------------- CORS --------------------- */
const rawOrigins = (process.env.CORS_ORIGIN || '*').trim();
const allowAll = rawOrigins === '' || rawOrigins === '*';
const originList = allowAll ? [] : rawOrigins.split(',').map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (allowAll) return cb(null, true);
      if (!origin) return cb(null, true); // same-origin or server-side
      if (originList.includes(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'));
    },
  })
);
app.options('*', cors());

/* --------------------- 정적 파일 --------------------- */
app.use(express.static('public'));

/* --------------------- AWS S3 --------------------- */
const region = process.env.AWS_REGION || 'us-east-1';
const bucket = process.env.S3_BUCKET; // Render 환경 변수 키: S3_BUCKET
const urlTtlSec = Number(process.env.SIGNED_URL_TTL_SEC || 300);
if (!bucket) console.warn('[WARN] S3_BUCKET is not set. Download will fail.');

const s3 = new S3Client({ region });

/* --------------------- 메모리 저장소 --------------------- */
const jobs = new Map();
const history = []; // 최근 작업 기록 (메모리)
const nid = (p = 'job') => `${p}_${crypto.randomBytes(8).toString('hex')}`;

/* --------------------- 유틸 --------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickMp4Format(info, targetHeight) {
  // mp4 + 오디오/비디오 모두 포함된 포맷만 후보
  const candidates = info.formats
    .filter((f) => f.container === 'mp4' && f.hasAudio && f.hasVideo && f.contentLength)
    .map((f) => ({
      itag: f.itag,
      height: f.height || 0,
      bitrate: f.bitrate || 0,
      contentLength: Number(f.contentLength || 0),
      fmt: f,
    }));

  if (!candidates.length) {
    // 그래도 없으면 mp4+videoandaudio 조건만 보기 (contentLength 없는 경우 포함)
    const loose = info.formats.filter((f) => f.container === 'mp4' && f.hasAudio && f.hasVideo);
    if (loose.length) return loose.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    return null;
  }

  const within = candidates.filter((c) => !targetHeight || c.height <= targetHeight);
  const chosen = (within.length ? within : candidates).sort((a, b) => b.height - a.height)[0];
  return chosen?.fmt || null;
}

/* --------------------- 라우트 --------------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

// 단순 파싱 (플랫폼 식별 + 리소스 ID) — 브라우저 UX용
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

// 다운로드 작업 생성 (YouTube → MP4 to S3)
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality = '720p' } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ code: 'BAD_URL', message: '유효한 YouTube URL을 입력하세요.' });
    }
    if (!bucket) return res.status(500).json({ code: 'NO_BUCKET', message: 'S3_BUCKET 미설정' });

    const jobId = nid('job');
    jobs.set(jobId, { status: 'queued', progress: 0 });
    res.json({ jobId });

    // 비동기 작업
    (async () => {
      try {
        jobs.set(jobId, { status: 'processing', progress: 1 });

        const info = await ytdl.getInfo(url);
        const targetMap = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, best: 0 };
        const target = targetMap[String(quality).toLowerCase()] ?? 720;
        const format = pickMp4Format(info, target);
        if (!format) throw new Error('mp4 포맷을 찾을 수 없습니다.');

        const key = `tmp/${jobId}.mp4`;
        const stream = ytdl.downloadFromInfo(info, { format });

        const uploader = new Upload({
          client: s3,
          params: {
            Bucket: bucket,
            Key: key,
            Body: stream,
            ContentType: 'video/mp4',
          },
          queueSize: 3,
          partSize: 8 * 1024 * 1024, // 8MB
          leavePartsOnError: false,
        });

        uploader.on('httpUploadProgress', (p) => {
          // 진행률 대략(0~90)
          const cur = jobs.get(jobId)?.progress ?? 1;
          const next = Math.min(90, cur + 1);
          jobs.set(jobId, { status: 'processing', progress: next });
        });

        await uploader.done();

        const signed = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: urlTtlSec }
        );

        jobs.set(jobId, {
          status: 'done',
          progress: 100,
          downloadUrl: signed,
          title: info.videoDetails?.title || '',
        });

        history.unshift({
          ts: Date.now(),
          jobId,
          url,
          title: info.videoDetails?.title || '',
          key,
        });
        if (history.length > 50) history.pop();
      } catch (err) {
        console.error('download error:', err);
        jobs.set(jobId, { status: 'error', progress: 0, error: String(err?.message || err) });
      }
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 'SERVER_ERR', message: 'internal error' });
  }
});

// 상태 조회
app.get('/api/download/status', (req, res) => {
  const { jobId } = req.query || {};
  const st = jobs.get(String(jobId));
  if (!st) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  res.json({ jobId, ...st });
});

// 최근 기록
app.get('/api/history', (_req, res) => {
  res.json({ items: history });
});

/* --------------------- 서버 시작 --------------------- */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
