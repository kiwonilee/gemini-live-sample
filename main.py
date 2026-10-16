import asyncio
import base64
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# 1. 환경 설정 및 Gemini 클라이언트 초기화
#    (.env 또는 환경변수의 GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT 등을 자동 인식)
# ---------------------------------------------------------------------------
load_dotenv()

MODEL_ID = "gemini-3.8-live"
STATIC_DIR = Path(__file__).parent / "static"

client = genai.Client()

LIVE_CONFIG = types.LiveConnectConfig(
    # =======================================================================
    # [AVATAR 변경 1] 응답 모달리티를 AUDIO -> VIDEO 단독으로 변경
    # - 아바타 모드에서는 음성(오디오 트랙)과 립싱크 영상이 합쳐진 조각난 MP4(video/mp4)
    #   스트림이 반환되므로, Modality.VIDEO만 단독으로 지정해야 합니다.
    # =======================================================================
    response_modalities=[types.Modality.VIDEO],
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Leda")
        )
    ),
    # =======================================================================
    # [AVATAR 변경 2] 내장 아바타(AvatarConfig) 설정 추가
    # - geap-sandbox-kwlee에서 즉시 사용 가능한 내장 아바타 이름(대소문자 구분, 총 11종):
    #   여성형: "Kira", "Ingrid", "Vera", "Carmen", "Piper", "Sam"
    #   남성형: "Jay", "Paul", "Ben", "Kai", "Leo"
    # =======================================================================
    avatar_config=types.AvatarConfig(
        avatar_name="Kira",
    ),
    input_audio_transcription=types.AudioTranscriptionConfig(),
    output_audio_transcription=types.AudioTranscriptionConfig(),
    system_instruction=(
        "You are a friendly AI assistant that watches live video from a camera and answers the user's spoken questions. "
        "For example, if the user shows a math problem and asks for the answer, clearly explain the solution and the final answer. "
        "If the user shows an object and asks about it, concisely describe its visible features, brand, purpose, and detailed information in natural Korean speech."
    ),
)

app = FastAPI(title="Gemini Live Sample")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# 2. 양방향 스트리밍 헬퍼 함수 (브라우저 <-> Gemini Live API)
# 실시간 대화는 **내가 말하고 보여주는 것(업스트림)**과 **AI가 답하고 움직이는 것(다운스트림)**이 동시에 일어나야 하므로 두 개의 비동기 함수로 분리되어 있습니다.
# ---------------------------------------------------------------------------
# 브라우저가 WebSocket으로 보낸 Base64 인코딩 데이터를 디코딩하여 Gemini 세션에 실시간 입력(send_realtime_input)으로 전달
async def forward_browser_to_gemini(ws: WebSocket, session: genai.live.AsyncSession):
    """브라우저에서 보낸 마이크 음성(16kHz PCM)과 카메라 프레임(JPEG)을 Gemini로 전달합니다."""
    while True:
        msg = await ws.receive_json()
        raw_bytes = base64.b64decode(msg["data"])

        if msg["type"] == "audio":
            await session.send_realtime_input(
                audio=types.Blob(data=raw_bytes, mime_type="audio/pcm;rate=16000")
            )
        elif msg["type"] == "video":
            await session.send_realtime_input(
                video=types.Blob(data=raw_bytes, mime_type="image/jpeg")
            )

# Gemini 서버에서 실시간으로 생성되는 이벤트들을 받아 브라우저로 전달합니다.
async def forward_gemini_to_browser(ws: WebSocket, session: genai.live.AsyncSession):
    """Gemini Live 세션에서 생성된 아바타 영상(video/mp4)과 자막을 브라우저로 전달합니다."""
    while True:
        async for response in session.receive():
            content = response.server_content
            if not content:
                continue

            # 1) 사용자가 말을 걸어 모델 답변을 끊은 경우 (끼어들기)
            # AI가 말하는 도중 사용자가 말을 걸면 content.interrupted가 True가 되며, 브라우저에 {"type": "interrupt"}를 보내 재생 중이던 아바타 영상을 즉시 최신 시점으로 스킵
            if content.interrupted:
                await ws.send_json({"type": "interrupt"})

            # ===============================================================
            # [AVATAR 변경 3] 모델이 생성한 아바타 비디오(video/mp4) 청크를 브라우저로 전달
            # - 아바타 모드에서는 part.inline_data.mime_type이 "video/mp4"로 내려오며,
            #   이 MP4 청크 안에 아바타 영상과 음성(Leda)이 함께 들어 있습니다.
            # ===============================================================
            if content.model_turn:
                for part in content.model_turn.parts:
                    if part.inline_data and part.inline_data.data:
                        mime_type = part.inline_data.mime_type or ""
                        b64_data = base64.b64encode(part.inline_data.data).decode("ascii")

                        if mime_type.startswith("video/"):
                            await ws.send_json({"type": "avatar_video", "data": b64_data})
                        elif mime_type.startswith("audio/"):
                            await ws.send_json({"type": "audio", "data": b64_data})

            # 3) 실시간 입출력 자막 전달 (사용자 발화 자막(user_transcript), 모델 답변 자막(model_transcript), 답변 완료 신호(turn_complete)를 브라우저 UI로 보냅니다.)
            if content.input_transcription and content.input_transcription.text:
                await ws.send_json({"type": "user_transcript", "text": content.input_transcription.text})

            if content.output_transcription and content.output_transcription.text:
                await ws.send_json({"type": "model_transcript", "text": content.output_transcription.text})

            # 4) 모델의 한 턴 답변 완료 알림
            if content.turn_complete:
                await ws.send_json({"type": "turn_complete"})


# ---------------------------------------------------------------------------
# 3. 라우트 및 WebSocket 엔드포인트
# ---------------------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # 브라우저의 WebSocket 연결을 수락
    await ws.accept()
    try:
        # Gemini Live 서버와 세션 연결
        async with client.aio.live.connect(model=MODEL_ID, config=LIVE_CONFIG) as session:
            await ws.send_json({"type": "status", "message": "연결됨 (아바타 준비 중...)"})
            # 브라우저 -> Gemini, Gemini -> 브라우저 를 위한 비동기 함수를 동시에 병렬 실행하여 끊김 없는 양방향 실시간 대화를 유지
            await asyncio.gather(
                forward_browser_to_gemini(ws, session),
                forward_gemini_to_browser(ws, session),
            )
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[ERROR] Gemini Live session error: {exc}", flush=True)
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
