const videoEl = document.getElementById("camera-preview");
const canvasEl = document.getElementById("capture-canvas");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const userTranscriptEl = document.getElementById("user-transcript");
const modelTranscriptEl = document.getElementById("model-transcript");
const startBtn = document.getElementById("start-btn");

// ===========================================================================
// [AVATAR 변경 1] 아바타 비디오 엘리먼트 및 MSE(MediaSource) 스트리밍 상태 변수
// ===========================================================================
const avatarVideoEl = document.getElementById("avatar-video");
const avatarPosterEl = document.getElementById("avatar-poster");
let avatarMediaSource = null;
let avatarSourceBuffer = null;
let avatarQueue = [];
let avatarLiveEdgeTimer = null;

let ws = null;
let mediaStream = null;
let audioCtx = null;
let micProcessor = null;
let videoInterval = null;
let activeSources = [];
let nextPlayTime = 0;
let resetModelTextOnNextChunk = false;

// 1. 후면 카메라 및 마이크 켜기
async function startMedia() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
  });
  videoEl.srcObject = mediaStream;
}

// 2. 마이크 오디오를 16kHz 16-bit PCM으로 변환해 전송
function setupMicrophoneStreaming() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const float32Audio = event.inputBuffer.getChannelData(0);
    const pcm16 = downsampleTo16kPcm(float32Audio, audioCtx.sampleRate);
    ws.send(JSON.stringify({ type: "audio", data: arrayBufferToBase64(pcm16.buffer) }));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
  micProcessor = { source, processor };
}

// 3. 카메라 영상을 1초마다 1장(1 FPS) JPEG로 캡처해 전송
function setupVideoStreaming() {
  const ctx = canvasEl.getContext("2d");
  videoInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !videoEl.videoWidth) return;

    const scale = Math.min(1, 640 / videoEl.videoWidth);
    canvasEl.width = Math.round(videoEl.videoWidth * scale);
    canvasEl.height = Math.round(videoEl.videoHeight * scale);
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

    const base64Jpeg = canvasEl.toDataURL("image/jpeg", 0.6).split(",")[1];
    ws.send(JSON.stringify({ type: "video", data: base64Jpeg }));
  }, 1000);
}

// ===========================================================================
// [AVATAR 변경 2] Gemini가 보내는 조각난 MP4(video/mp4, 음성+립싱크 영상)를
//                 MediaSource Extensions(MSE)로 실시간 이어붙여 재생하는 함수들
// ===========================================================================
function initAvatarPlayer() {
  stopAvatarPlayer();
  if (!window.MediaSource) return;

  avatarMediaSource = new MediaSource();
  avatarVideoEl.src = URL.createObjectURL(avatarMediaSource);

  avatarVideoEl.onplaying = () => {
    avatarPosterEl.classList.add("hidden");
    setStatus("연결됨 (듣고 있는 중...)", true);
  };

  avatarMediaSource.addEventListener(
    "sourceopen",
    () => {
      const codecs = [
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4; codecs="avc1.4D401F, mp4a.40.2"',
        "video/mp4",
      ];
      const mime = codecs.find((c) => MediaSource.isTypeSupported(c)) || "video/mp4";
      avatarSourceBuffer = avatarMediaSource.addSourceBuffer(mime);
      avatarSourceBuffer.mode = "sequence";
      avatarSourceBuffer.addEventListener("updateend", () => {
        if (avatarVideoEl.paused && avatarVideoEl.buffered.length > 0) {
          avatarVideoEl.play().catch(() => {});
        }
        trimAvatarBuffer();
        pumpAvatarQueue();
      });
      pumpAvatarQueue();
    },
    { once: true }
  );

  // 재생 지연(Latency)이 쌓이지 않도록 라이브 끝단(Live Edge)을 유지
  avatarLiveEdgeTimer = setInterval(() => {
    if (avatarVideoEl.buffered.length > 0 && !avatarVideoEl.paused) {
      const liveEdge = avatarVideoEl.buffered.end(avatarVideoEl.buffered.length - 1);
      if (liveEdge - avatarVideoEl.currentTime > 2.5) {
        avatarVideoEl.currentTime = liveEdge - 0.1;
      }
    }
  }, 500);
}

function pushAvatarVideoChunk(base64Data) {
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  avatarQueue.push(bytes.buffer);
  pumpAvatarQueue();
}

function pumpAvatarQueue() {
  if (
    !avatarSourceBuffer ||
    avatarSourceBuffer.updating ||
    avatarQueue.length === 0 ||
    !avatarMediaSource ||
    avatarMediaSource.readyState !== "open"
  ) {
    return;
  }
  const nextChunk = avatarQueue.shift();
  try {
    avatarSourceBuffer.appendBuffer(nextChunk);
  } catch (err) {
    console.error("Avatar appendBuffer error:", err);
  }
}

function trimAvatarBuffer() {
  if (!avatarSourceBuffer || avatarSourceBuffer.updating || avatarVideoEl.buffered.length === 0) return;
  const start = avatarVideoEl.buffered.start(0);
  const end = avatarVideoEl.currentTime - 10;
  if (end - start > 5) {
    try {
      avatarSourceBuffer.remove(start, end);
    } catch (_) {}
  }
}

function interruptAvatarVideo() {
  avatarQueue = [];
  if (avatarVideoEl.buffered.length > 0) {
    const liveEdge = avatarVideoEl.buffered.end(avatarVideoEl.buffered.length - 1);
    avatarVideoEl.currentTime = Math.max(avatarVideoEl.currentTime, liveEdge - 0.1);
  }
}

function stopAvatarPlayer() {
  if (avatarLiveEdgeTimer) clearInterval(avatarLiveEdgeTimer);
  avatarLiveEdgeTimer = null;
  avatarQueue = [];
  avatarSourceBuffer = null;
  if (avatarMediaSource && avatarMediaSource.readyState === "open") {
    try {
      avatarMediaSource.endOfStream();
    } catch (_) {}
  }
  avatarMediaSource = null;
  avatarVideoEl.pause();
  if (avatarVideoEl.src && avatarVideoEl.src.startsWith("blob:")) {
    URL.revokeObjectURL(avatarVideoEl.src);
  }
  avatarVideoEl.removeAttribute("src");
  avatarVideoEl.load();
  avatarPosterEl.classList.remove("hidden");
}

// 4. (AUDIO 단독 모드용 예비) Gemini가 보낸 24kHz PCM 오디오 청크 재생
function playPcm24kAudio(base64Data) {
  if (!audioCtx) return;
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

  const buffer = audioCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  nextPlayTime = Math.max(nextPlayTime, audioCtx.currentTime);
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;

  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter((s) => s !== source);
  };
}

function stopPlayingAudio() {
  activeSources.forEach((s) => { try { s.stop(); } catch (_) {} });
  activeSources = [];
  if (audioCtx) nextPlayTime = audioCtx.currentTime;
}

// 5. 실시간 세션 시작 / 종료
async function startSession() {
  try {
    setStatus("카메라/마이크 준비 중...", false);
    await startMedia();
    setupMicrophoneStreaming();
    setupVideoStreaming();

    // [AVATAR 변경 3] 세션 시작 시 아바타 MSE 비디오 플레이어 초기화
    initAvatarPlayer();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      setStatus("연결 중...", false);
      startBtn.textContent = "⏹️ 종료하기";
      startBtn.classList.add("running");
      userTranscriptEl.textContent = "🎙️ 듣고 있습니다. 카메라로 보여주며 질문해 보세요!";
      modelTranscriptEl.textContent = "";
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        setStatus(msg.message, true);
      } else if (msg.type === "avatar_video") {
        // [AVATAR 변경 4] 서버에서 받은 아바타 MP4(video/mp4) 청크를 MSE 큐에 추가
        pushAvatarVideoChunk(msg.data);
      } else if (msg.type === "audio") {
        playPcm24kAudio(msg.data);
      } else if (msg.type === "interrupt") {
        // [AVATAR 변경 5] 끼어들기(Interrupt) 발생 시 아바타 버퍼도 즉시 스킵
        interruptAvatarVideo();
        stopPlayingAudio();
        resetModelTextOnNextChunk = true;
      } else if (msg.type === "user_transcript") {
        userTranscriptEl.textContent = `🗣️ 나: ${msg.text}`;
      } else if (msg.type === "model_transcript") {
        if (resetModelTextOnNextChunk) {
          modelTranscriptEl.textContent = "";
          resetModelTextOnNextChunk = false;
        }
        modelTranscriptEl.textContent += msg.text;
      } else if (msg.type === "turn_complete") {
        resetModelTextOnNextChunk = true;
      } else if (msg.type === "error") {
        setStatus("오류 발생", false);
        modelTranscriptEl.textContent = `⚠️ 오류: ${msg.message}`;
      }
    };

    ws.onclose = () => stopSession();
    ws.onerror = () => stopSession();
  } catch (err) {
    setStatus("권한/연결 실패", false);
    modelTranscriptEl.textContent = `⚠️ 오류: ${err.message}`;
    stopSession();
  }
}

function stopSession() {
  if (videoInterval) clearInterval(videoInterval);
  videoInterval = null;
  stopPlayingAudio();
  // [AVATAR 변경 6] 세션 종료 시 아바타 비디오 플레이어 정리
  stopAvatarPlayer();
  if (micProcessor) {
    micProcessor.processor.disconnect();
    micProcessor.source.disconnect();
    micProcessor = null;
  }
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  if (ws) ws.close();
  ws = null;
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  mediaStream = null;

  setStatus("대기 중", false);
  startBtn.textContent = "🎙️ 시작하기";
  startBtn.classList.remove("running");
}

function setStatus(text, isActive) {
  statusText.textContent = text;
  statusDot.classList.toggle("active", Boolean(isActive));
}

function downsampleTo16kPcm(float32Buffer, inputSampleRate) {
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(float32Buffer.length / ratio);
  const result = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const idx = Math.min(float32Buffer.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, float32Buffer[idx]));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return result;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

startBtn.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) stopSession();
  else startSession();
});
