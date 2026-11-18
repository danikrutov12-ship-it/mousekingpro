#!/usr/bin/env bash
# Выкладка worker/vsr/{handler.py,start.sh,diag.py} на сетевой диск RunPod через временный CPU-под.
# Нужен ключ API RunPod в ~/.runpod-key. Диск — первый сетевой диск аккаунта с именем mouse-king-pro-models.
# Необязательный аргумент — shell-команда, выполняемая на поде после записи файлов.
set -euo pipefail
K=$(cat ~/.runpod-key)
W="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
VOL=$(curl -s -H "Authorization: Bearer $K" https://rest.runpod.io/v1/networkvolumes | python3 -c "import json,sys;v=[x for x in json.load(sys.stdin) if x['name']=='mouse-king-pro-models'][0];print(v['id'],v['dataCenterId'])")
read -r VOL_ID DC <<<"$VOL"
CMD="mkdir -p /runpod-volume/vsr/jobs"
for f in handler.py start.sh diag.py; do
  CMD="$CMD && echo $(base64 -w0 "$W/$f") | base64 -d > /runpod-volume/vsr/$f"
done
CMD="$CMD; ${1:-true}; sleep 3600"
python3 - "$CMD" "$VOL_ID" "$DC" > "$TMP/pod.json" <<'EOF'
import json,sys
print(json.dumps({"name":"mkp-deploy-vsr","computeType":"CPU","cpuFlavorIds":["cpu3c"],"vcpuCount":2,"imageName":"ubuntu:22.04",
  "networkVolumeId":sys.argv[2],"dataCenterIds":[sys.argv[3]],"containerDiskInGb":5,"dockerStartCmd":["bash","-c",sys.argv[1]]}))
EOF
ID=$(curl -s -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' https://rest.runpod.io/v1/pods -d @"$TMP/pod.json" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "под $ID (\$0.06/ч) — жду, пока запишет файлы"
up() { curl -s https://api.runpod.io/graphql -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d "{\"query\":\"query { pod(input:{podId:\\\"$ID\\\"}) { runtime { uptimeInSeconds } } }\"}" | python3 -c "import json,sys;r=(json.load(sys.stdin)['data']['pod'] or {}).get('runtime');print(r['uptimeInSeconds'] if r else 0)"; }
until [ "$(up)" -ge 40 ]; do sleep 10; done
curl -s -o /dev/null -w "под удалён: %{http_code}\n" -X DELETE -H "Authorization: Bearer $K" "https://rest.runpod.io/v1/pods/$ID"
