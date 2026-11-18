#!/usr/bin/env bash
# Тест эндпоинта VSR маленьким видео (до ~7 МБ, передаётся в запросе base64, без S3).
#   ./test.sh видео.mp4 [режим] [рамки JSON] [имя эндпоинта] [куда сохранить]
# Пример: ./test.sh test2.mp4 sttn-auto '[[0.3,0.88,0.7,0.98]]'
# Рамки — доли кадра [x0, y0, x1, y1]. Через 25 минут задача отменяется, чтобы не тратить деньги.
set -uo pipefail
K=$(cat ~/.runpod-key)
VIDEO=${1:?видео}
MODE=${2:-sttn-auto}
AREAS=${3:-[]}
NAME=${4:-mouse-king-vsr}
OUT=${5:-./vsr-out.mp4}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
E=$(curl -s https://api.runpod.io/graphql -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d '{"query":"query { myself { endpoints { id name } } }"}' | python3 -c "import json,sys;print([e['id'] for e in json.load(sys.stdin)['data']['myself']['endpoints'] if e['name']=='$NAME'][0])")
python3 -c "
import json,base64,sys
b=base64.b64encode(open(sys.argv[1],'rb').read()).decode()
json.dump({'input':{'video_b64':b,'ext':sys.argv[1].rsplit('.',1)[1],'mode':sys.argv[2],'areas':json.loads(sys.argv[3])}},open('$TMP/job.json','w'))" "$VIDEO" "$MODE" "$AREAS"
for try in 1 2 3; do
  R=$(curl -s -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' "https://api.runpod.ai/v2/$E/run" -d @"$TMP/job.json")
  J=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])" 2>/dev/null) && break
  echo "запуск не принят (попытка $try): ${R:0:300}"; sleep 5
done
[ -n "${J:-}" ] || { echo "задача не создана"; exit 1; }
echo "задача $J на $NAME"
T0=$(date +%s)
while :; do
  r=$(curl -s -H "Authorization: Bearer $K" "https://api.runpod.ai/v2/$E/status/$J")
  st=$(echo "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status'), d.get('output') if isinstance(d.get('output'),str) else '')")
  h=$(curl -s -H "Authorization: Bearer $K" "https://api.runpod.ai/v2/$E/health" | python3 -c "import json,sys;print(json.load(sys.stdin)['workers'])")
  echo "$(( $(date +%s) - T0 ))с $st | $h"
  case $st in COMPLETED*|FAILED*|CANCELLED*|TIMED_OUT*) echo "$r" > "$TMP/job.out"; break;; esac
  if [ $(( $(date +%s) - T0 )) -gt 1500 ]; then curl -s -X POST -H "Authorization: Bearer $K" "https://api.runpod.ai/v2/$E/cancel/$J"; echo " — отменено по времени"; exit 1; fi
  sleep 15
done
python3 -c "
import json,base64
d=json.load(open('$TMP/job.out')); o=d.get('output') or {}
print(d['status'], 'ожидание', d.get('delayTime'), 'мс, работа', d.get('executionTime'), 'мс')
print({k:v for k,v in o.items() if k!='video_b64'} if isinstance(o,dict) else str(o)[:3000])
if d.get('error'): print('ОШИБКА:', str(d['error'])[:3000])
if isinstance(o,dict) and o.get('video_b64'): open('$OUT','wb').write(base64.b64decode(o['video_b64'])); print('сохранено: $OUT')"
