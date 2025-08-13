# MultiClip API (Docker on Render)

## 배포 요약
1) 위 파일들을 GitHub 저장소 루트에 업로드
2) Render에서 Runtime을 **Docker**로 배포
3) 환경변수: `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SIGNED_URL_TTL_SEC`
4) Health 확인: `GET /health` → `{ ok: true }`
5) 흐름: `POST /api/parse` → `POST /api/download` → `GET /api/download/status?jobId=...`

## cURL 예시
```bash
curl -s https://multiclip-api.onrender.com/health

curl -s -X POST https://multiclip-api.onrender.com/api/parse  -H 'Content-Type: application/json'  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'

curl -s -X POST https://multiclip-api.onrender.com/api/download  -H 'Content-Type: application/json'  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","quality":"720p","type":"video"}'

curl -s 'https://multiclip-api.onrender.com/api/download/status?jobId=job_xxx'
```
