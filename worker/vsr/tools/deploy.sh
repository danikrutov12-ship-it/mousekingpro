#!/usr/bin/env bash
# Выкладка worker/vsr/{handler.py,start.sh,diag.py} на сетевой диск RunPod через временный CPU-под.
# Файлы под берёт с GitHub (ветка из аргумента, по умолчанию main) — сначала сделайте push.
# Нужен ключ API RunPod в ~/.runpod-key. Работает через GraphQL (REST rest.runpod.io бывает недоступен).
set -euo pipefail
K=$(cat ~/.runpod-key)
BRANCH=${1:-main}
gql() { curl -s https://api.runpod.io/graphql -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d "$1"; }
read -r VOL_ID DC < <(gql '{"query":"query { myself { networkVolumes { id name dataCenterId } } }"}' | python3 -c "import json,sys;v=[x for x in json.load(sys.stdin)['data']['myself']['networkVolumes'] if x['name']=='mouse-king-pro-models'][0];print(v['id'],v['dataCenterId'])")
# по точному коммиту, а не по имени ветки: raw.githubusercontent.com кэширует ветки на несколько минут
SHA=$(git ls-remote https://github.com/danikrutov12-ship-it/mousekingpro.git "refs/heads/$BRANCH" | cut -f1)
[ -n "$SHA" ] || { echo "ветка $BRANCH не найдена на GitHub" >&2; exit 1; }
echo "выкладываю $BRANCH @ ${SHA:0:7}"
RAW="https://raw.githubusercontent.com/danikrutov12-ship-it/mousekingpro/$SHA/worker/vsr"
SCRIPT="mkdir -p /runpod-volume/vsr/jobs && for f in handler.py job.py start.sh diag.py; do curl -sfL -o /runpod-volume/vsr/\$f $RAW/\$f; done; sleep 3600"
B=$(printf '%s' "$SCRIPT" | base64 -w0)
BODY=$(python3 - "$B" "$VOL_ID" "$DC" <<'EOF'
import json,sys
q = "mutation($input: deployCpuPodInput!) { deployCpuPod(input: $input) { id } }"
inp = {"name":"mkp-deploy-vsr","imageName":"ubuntu:22.04","instanceId":"cpu3c-2-4","cloudType":"SECURE","networkVolumeId":sys.argv[2],
       "dataCenterId":sys.argv[3],"containerDiskInGb":5,"volumeMountPath":"/runpod-volume",
       "dockerArgs":"bash -c 'apt-get update -qq && apt-get install -y -qq curl >/dev/null; echo %s | base64 -d | bash'" % sys.argv[1]}
print(json.dumps({"query":q,"variables":{"input":inp}}))
EOF
)
ID=$(gql "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data']['deployCpuPod']['id'])")
echo "под $ID — жду, пока запишет файлы"
up() { gql "{\"query\":\"query { pod(input:{podId:\\\"$ID\\\"}) { runtime { uptimeInSeconds } } }\"}" | python3 -c "import json,sys;r=(json.load(sys.stdin)['data']['pod'] or {}).get('runtime');print(r['uptimeInSeconds'] if r else 0)"; }
until [ "$(up)" -ge 60 ]; do sleep 10; done
gql "{\"query\":\"mutation { podTerminate(input:{podId:\\\"$ID\\\"}) }\"}" >/dev/null && echo "под удалён"
