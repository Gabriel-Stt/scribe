import argparse
import asyncio
import os
import queue
import threading

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Parakeet ASR Server")

# MLX requires all GPU ops to run on the same thread where the model was loaded.
# We use a single persistent worker thread for both loading and inference.

_model = None
_model_ready = False
_model_error: str | None = None

# (audio_path, result_dict) — result_dict has 'result', 'error', 'event' keys
_work_queue: queue.Queue = queue.Queue()


def _mlx_worker() -> None:
    """Single thread that owns all MLX / GPU state."""
    global _model, _model_ready, _model_error
    try:
        import parakeet_mlx
        _model = parakeet_mlx.from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
        _model_ready = True
    except Exception as exc:
        _model_error = str(exc)
        return

    # Process transcription requests on this same thread indefinitely
    while True:
        audio_path, holder = _work_queue.get()
        try:
            result = _model.transcribe(
                audio_path, chunk_duration=60.0, overlap_duration=5.0
            )
            holder["result"] = result
            holder["error"] = None
        except Exception as exc:
            holder["result"] = None
            holder["error"] = str(exc)
        finally:
            holder["event"].set()


threading.Thread(target=_mlx_worker, daemon=True, name="mlx-worker").start()


# ---- Pydantic models ----

class TranscribeRequest(BaseModel):
    audio_path: str


class Segment(BaseModel):
    text: str
    start: float
    end: float


class TranscribeResponse(BaseModel):
    segments: list[Segment]
    full_text: str


# ---- Endpoints ----

@app.get("/health")
async def health():
    if _model_error:
        return {"status": "error", "error": _model_error}
    return {"status": "ready" if _model_ready else "loading"}


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(request: TranscribeRequest):
    if _model_error:
        raise HTTPException(status_code=500, detail=f"Model failed to load: {_model_error}")
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Model is still loading, please retry")

    audio_path = request.audio_path
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=400, detail=f"Audio file not found: {audio_path}")

    # Submit work to the MLX thread and wait for its event — the wait itself
    # runs in a thread-pool executor so we don't block the uvicorn event loop.
    done_event = threading.Event()
    holder: dict = {"result": None, "error": None, "event": done_event}
    _work_queue.put((audio_path, holder))

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, done_event.wait)

    if holder["error"]:
        raise HTTPException(status_code=500, detail=holder["error"])

    result = holder["result"]
    segments = [
        Segment(text=s.text.strip(), start=s.start, end=s.end)
        for s in result.sentences
        if s.text.strip()
    ]
    return TranscribeResponse(segments=segments, full_text=result.text.strip())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parakeet ASR sidecar server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
