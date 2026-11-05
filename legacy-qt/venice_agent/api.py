"""REST-клиент Venice: список моделей, генерация изображений и видео."""

from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Callable

import httpx

MODEL_TYPES = ("text", "image", "video")


class VeniceError(Exception):
    pass


HINTS = {
    401: "Ключ Venice не подошёл. Проверьте его в настройках.",
    402: "На балансе Venice API закончились деньги. Пополните его: https://venice.ai/settings/api",
    429: "Слишком много запросов к Venice. Подождите немного и повторите.",
}


def explain(status: int, msg) -> str:
    """Понятный текст ошибки API: подсказка для частых кодов плюс исходное сообщение Venice."""
    hint = HINTS.get(status)
    return f"{hint}\n\n({status}: {msg})" if hint else f"HTTP {status}: {msg}"


def _error_text(r: httpx.Response) -> str:
    try:
        data = r.json()
        msg = data.get("error") or data.get("message") or data.get("details") or data
    except ValueError:
        msg = r.text[:500]
    return explain(r.status_code, msg)


def usd(price) -> float | None:
    """Цена из pricing Venice: {"usd": 0.03, "diem": 0.03} → 0.03."""
    return float(price["usd"]) if isinstance(price, dict) and "usd" in price else None


def image_price(model: dict, params: dict) -> float | None:
    """Стоимость генерации по pricing модели: с учётом разрешения, качества и числа вариантов."""
    pricing = model.get("pricing") or {}
    res, quality = params.get("resolution"), params.get("quality")
    one = None
    if res and quality:
        one = usd(((pricing.get("quality") or {}).get(res) or {}).get(quality))
    if one is None and res:
        one = usd((pricing.get("resolutions") or {}).get(res))
    if one is None:
        one = usd(pricing.get("generation"))
    return None if one is None else one * int(params.get("variants") or 1)


def text_price(model: dict) -> tuple[float, float] | None:
    """Цена текстовой модели за 1 млн токенов: (вход, выход)."""
    pricing = model.get("pricing") or {}
    inp, out = usd(pricing.get("input")), usd(pricing.get("output"))
    return (inp, out) if inp is not None and out is not None else None


def money(value: float) -> str:
    """$0.0031 для копеечных сумм, $0.12 / $9.85 для обычных."""
    if value == 0:
        return "$0"
    if value < 0.01:
        return f"${value:.4f}".rstrip("0")
    return f"${value:.2f}"


class VeniceAPI:
    def __init__(self, api_key: str, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {api_key}"}
        self.spent = 0.0  # сколько списали запросы этого клиента (веб-поиск), USD

    def balance(self) -> dict:
        """Остатки на счету API: {"USD": 9.85, "DIEM": 0, ...}."""
        r = httpx.get(f"{self.base_url}/api_keys/rate_limits", headers=self.headers, timeout=20)
        if r.status_code >= 400:
            raise VeniceError(_error_text(r))
        return (r.json().get("data") or {}).get("balances") or {}

    def video_quote(self, params: dict) -> float:
        """Цена видео до генерации."""
        body = {k: params[k] for k in ("model", "duration", "resolution", "aspect_ratio", "audio") if k in params}
        return float(self._post("/video/quote", body, timeout=20).json()["quote"])

    def _post(self, path: str, body: dict, timeout: float = 300) -> httpx.Response:
        r = httpx.post(f"{self.base_url}{path}", json=body, headers=self.headers, timeout=timeout)
        if r.status_code >= 400:
            raise VeniceError(_error_text(r))
        return r

    # ------------------------------------------------------------ модели

    def list_models(self, model_type: str) -> list[dict]:
        r = httpx.get(f"{self.base_url}/models", params={"type": model_type},
                      headers=self.headers, timeout=30)
        if r.status_code >= 400:
            raise VeniceError(_error_text(r))
        out = []
        for m in r.json().get("data", []):
            spec = m.get("model_spec") or {}
            if spec.get("offline"):
                continue
            caps = spec.get("capabilities") or {}
            out.append({
                "id": m["id"],
                "type": m.get("type", model_type),
                "name": spec.get("name") or m["id"],
                "description": spec.get("description", ""),
                "uncensored": bool(spec.get("uncensored")),
                "tools": bool(caps.get("supportsFunctionCalling")),
                "vision": bool(caps.get("supportsVision")),
                "reasoning": bool(caps.get("supportsReasoning")),
                "web_search": bool(caps.get("supportsWebSearch")),
                "context": spec.get("availableContextTokens") or m.get("context_length"),
                "constraints": spec.get("constraints") or {},
                "pricing": spec.get("pricing") or {},
            })
        return sorted(out, key=lambda x: x["name"].lower())

    # ------------------------------------------------------------ веб-поиск

    def web_search(self, model: str, query: str, limit: int) -> str:
        body = {
            "model": model,
            "messages": [{"role": "user", "content":
                          f"Search the web for: {query}\n\nList the {limit} most relevant results. "
                          "For each give the title, the URL and a 1-2 sentence summary. "
                          "Answer in the language of the query."}],
            "temperature": 0.2,
            "venice_parameters": {"enable_web_search": "on", "include_venice_system_prompt": False,
                                  "strip_thinking_response": True},
        }
        data = self._post("/chat/completions", body, timeout=120).json()
        self.spent += usd(data.get("cost")) or 0.0
        answer = data["choices"][0]["message"].get("content") or ""
        citations = (data.get("venice_parameters") or {}).get("web_search_citations") or []
        sources = "\n".join(
            f"- {c.get('title', '')} — {c.get('url', '')}" for c in citations[: limit * 2] if c.get("url"))
        return answer.strip() + (f"\n\nИсточники:\n{sources}" if sources else "")

    # ------------------------------------------------------------ изображения

    def generate_image(self, params: dict, out_dir: Path) -> list[Path]:
        body = {"format": "png", "return_binary": False, **params}
        r = self._post("/image/generate", body)
        data = r.json()
        images = data.get("images") or []
        if not images:
            violations = data.get("content_policy_violation_count")
            raise VeniceError("Модель не вернула изображений" + (f" (отклонено политикой: {violations})" if violations else ""))
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        paths = []
        for i, b64 in enumerate(images):
            p = out_dir / f"image-{stamp}-{i + 1}.{body['format']}"
            p.write_bytes(base64.b64decode(b64))
            paths.append(p)
        return paths

    # ------------------------------------------------------------ видео

    def generate_video(self, params: dict, out_dir: Path,
                       progress: Callable[[str], None],
                       should_stop: Callable[[], bool]) -> Path:
        queued = self._post("/video/queue", params, timeout=120).json()
        queue_id = queued["queue_id"]
        download_url = queued.get("download_url")
        progress(f"Видео в очереди (id {queue_id[:8]}…)")
        started = time.time()
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"video-{time.strftime('%Y%m%d-%H%M%S')}.mp4"

        while True:
            if should_stop():
                raise VeniceError("Остановлено пользователем (генерация на сервере может продолжиться)")
            if time.time() - started > 60 * 60:
                raise VeniceError(f"Видео не готово за час. queue_id: {queue_id}")
            r = self._post("/video/retrieve", {"queue_id": queue_id}, timeout=600)
            ctype = r.headers.get("content-type", "")
            if ctype.startswith("video/") or ctype == "application/octet-stream":
                path.write_bytes(r.content)
                return path
            status = r.json()
            if status.get("status") == "COMPLETED" and download_url:
                return self._download(download_url, path)
            done = status.get("execution_duration", 0) / 1000
            avg = status.get("average_execution_time", 0) / 1000
            progress(f"Генерация видео: {done:.0f} с" + (f" из ~{avg:.0f} с" if avg else ""))
            for _ in range(10):  # 5 секунд с проверкой отмены
                if should_stop():
                    break
                time.sleep(0.5)

    def _download(self, url: str, path: Path) -> Path:
        last_error: Exception | None = None
        for _ in range(3):
            try:
                with httpx.stream("GET", url, timeout=600, follow_redirects=True) as r:
                    r.raise_for_status()
                    with open(path, "wb") as f:
                        for chunk in r.iter_bytes():
                            f.write(chunk)
                return path
            except httpx.HTTPError as e:
                last_error = e
                time.sleep(2)
        raise VeniceError(f"Не удалось скачать видео: {last_error}")
