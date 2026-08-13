"""
Minimal local TTS server that mimics the OmniVoice /v1/audio/speech contract,
but runs Piper underneath (CPU-friendly, real-time on modest hardware).

Endpoints:
  GET  /health
  POST /v1/audio/speech   -- body: { model, input, voice, response_format, speed, stream }

Non-streaming responses include:
  X-Synthesis-Latency-S
  X-Audio-Duration-S
(same headers demo_omnivoice.js already reads)

Streaming responses (response_format="pcm", stream=true) return raw 16-bit
mono PCM chunks -- same shape the demo script already expects.

Setup:
    pip install piper-tts fastapi uvicorn
    python -m piper.download_voices en_US-lessac-medium

Run:
    python piper_openai_server.py --voice en_US-lessac-medium --port 8880
"""

import argparse
import io
import time
import wave
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from piper import PiperVoice
from piper.download_voices import download_voice

app = FastAPI()

# populated at startup
STATE = {"voice": None, "voice_name": None, "sample_rate": None}


class SpeechRequest(BaseModel):
    model: str = "piper"
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float = 1.0
    stream: bool = False


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "ready": STATE["voice"] is not None,
        "model_loaded": STATE["voice"] is not None,
        "model_id": STATE["voice_name"],
    }


def _synthesize_wav_bytes(text: str, length_scale: float) -> bytes:
    voice: PiperVoice = STATE["voice"]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        try:
            from piper import SynthesisConfig

            cfg = SynthesisConfig(length_scale=length_scale)
            voice.synthesize_wav(text, wav_file, syn_config=cfg)
        except ImportError:
            voice.synthesize(text, wav_file)
    return buf.getvalue()


@app.post("/v1/audio/speech")
def speak(req: SpeechRequest):
    if STATE["voice"] is None:
        raise HTTPException(status_code=503, detail="voice not loaded")

    # speed>1 = faster in OmniVoice's convention; Piper's length_scale is the
    # inverse (bigger = slower), so invert it.
    length_scale = 1.0 / req.speed if req.speed else 1.0

    started = time.perf_counter()
    wav_bytes = _synthesize_wav_bytes(req.input, length_scale)
    latency_s = time.perf_counter() - started

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        duration_s = frames / float(rate)

    if req.response_format == "pcm":
        # strip the 44-byte WAV header, return raw PCM (streamed or not)
        pcm_bytes = wav_bytes[44:]
        if req.stream:
            def chunker():
                chunk_size = 4096
                for i in range(0, len(pcm_bytes), chunk_size):
                    yield pcm_bytes[i : i + chunk_size]

            return StreamingResponse(chunker(), media_type="application/octet-stream")
        return Response(content=pcm_bytes, media_type="application/octet-stream")

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Synthesis-Latency-S": f"{latency_s:.3f}",
            "X-Audio-Duration-S": f"{duration_s:.3f}",
        },
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default="en_US-lessac-medium")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument(
        "--data-dir",
        default=str(Path.home() / ".local" / "share" / "piper" / "voices"),
        help="where voice models are/will be stored",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = data_dir / f"{args.voice}.onnx"

    if not onnx_path.exists():
        print(f"Downloading voice '{args.voice}' to {data_dir} ...")
        download_voice(args.voice, data_dir)

    print(f"Loading voice from {onnx_path} ...")
    STATE["voice"] = PiperVoice.load(str(onnx_path))
    STATE["voice_name"] = args.voice

    print(f"Serving on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
