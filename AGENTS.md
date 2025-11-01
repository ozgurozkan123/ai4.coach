# Voice AI Overlay Agent Overview

## Current Repository Snapshot
- Root workspace: Rust-centric Windows overlay framework with supporting TypeScript bindings. Core crates live under `crates/` (`overlay`, `dll`, `hook`, `client`, `event`, `common`, `vulkan-layer`).
- Overlay runtime: `crates/overlay` renders surfaces across DirectX (9,11,12), OpenGL, and Vulkan via shared GPU resources. Window/event plumbing sits in `backend/`, `renderer/`, `hook/`.
- Injection and IPC: `crates/dll` and `crates/client` handle process injection plus named-pipe IPC with consumers. `crates/hook` wraps Microsoft Detours for API interception.
- Front-end bindings: `packages/core` and `packages/electron` expose JavaScript/TypeScript APIs and native bindings for Node/Electron examples (`examples/node`).
- Example overlays: `examples/rust` demonstrate input capture and GPU drawing, validating the core overlay lifecycle.

## Target Agent Vision
Goal: deliver a near-realtime voice-enabled assistant that lives inside the overlay, combining microphone input, live screen context, and custom backend intelligence.

- Capture: access microphone locally, stream audio chunks for low-latency transcription.
- Visual grounding: grab 10 screenshots from the viewport (5 preceding seconds at 1 fps + 5 during active speech).
- Reasoning: send transcript + ordered image set to OpenAI multimodal endpoint to build a contextual understanding of "what I see" and "what I say". Incorporate responses from a customer-owned backend LLM for domain knowledge.
- Response synthesis: route combined reasoning back through OpenAI (or the private LLM) for final textual answer, convert to speech through ElevenLabs TTS, and deliver audio inside the overlay with synchronized captions.
- Overlay UX: render lightweight HUD for recording status, waveform visualization, generated answer text, and playback controls. Preserve input passthrough when idle.

## Proposed System Architecture
1. **Capture Layer** (new crate or module):
   - Microphone capture via WASAPI (Rust) or Web Audio (if leveraging Electron). Stream PCM to transcription.
   - Screen recorder service built atop existing overlay surface hooks; maintain ring buffer of pre-roll frames.
2. **Transcription & Buffering**:
   - Incremental speech-to-text using OpenAI Realtime or Whisper streaming API.
   - Trigger command window detection (start/stop) via VAD or push-to-talk gesture using existing input capture.
3. **Context Aggregator**:
   - Package `transcript`, `screenshot[]`, and optional metadata (active window, cursor position) into a multimodal prompt payload.
   - Invoke OpenAI multimodal endpoint; merge with private LLM answer retrieved via custom backend API.
4. **Response Orchestrator**:
   - Decide final message (blend or rerank OpenAI + private LLM outputs).
   - Request ElevenLabs speech synthesis; stream audio back.
5. **Overlay Presentation**:
   - Extend `crates/overlay` renderer with UI widgets: waveform, timeline, subtitle overlay.
   - IPC events broadcast to front-end (Node/Electron) for optional control panel.

## Implementation Milestones
1. **Scaffolding**
   - Define new crate/package (e.g., `crates/agent`) for capture + orchestration.
   - Extend IPC protocol (`crates/common`) for audio/video payload routing.
2. **Sensing**
   - Implement microphone capture with ring buffer and VAD triggers.
   - Add screenshot scheduler leveraging existing window hooks.
3. **AI Integration**
   - Build OpenAI multimodal client with configurable model endpoints.
   - Integrate custom backend LLM API; support fallback logic.
4. **Response Delivery**
   - Stream ElevenLabs audio to overlay playback engine.
   - Display textual answer + image highlights inside overlay.
5. **User Experience**
   - Provide Electron control surface for configuration and debugging.
   - Add telemetry/logging hooks for latency and accuracy metrics.

## Open Questions
- Do we host the agent loop inside the injected process or an external controller communicating via IPC?
- Preferred pathway for private LLM access (REST, gRPC, WebSocket) and expected latency budget?
- Storage/retention policy for captured screenshots and audio (in-memory only vs. disk cache)?
- Should the overlay present historical transcript threads or operate ephemeral per command?

## Next Steps
- Confirm platform targets (Windows-only vs. cross-platform overlay) to select capture APIs.
- Lock in OpenAI model choices and ElevenLabs voice profile parameters.
- Draft IPC schema changes and prototype a minimal microphone capture pipeline feeding synthetic responses.

## Execution Plan

### Phase 0 — Discovery & Foundations (Week 0-1)
- Audit existing overlay rendering and IPC paths for extension points.
- Spike microphone capture via WASAPI (Rust) and Electron (Web Audio) to validate latency and resource usage.
- Define screenshot ring buffer contract, including retention policy and compression strategy.
- Document security/privacy requirements for audio and image handling.

### Phase 1 — Capture Services (Week 2-4)
- Build `crates/agent` with modular capture pipeline abstractions.
- Implement microphone capture driver with VAD, buffering, and backpressure controls.
- Implement screenshot scheduler producing timestamped frames and expose via IPC.
- Add automated tests for capture timing accuracy and resource cleanup.

### Phase 2 — AI Integration (Week 5-7)
- Create multimodal client SDK supporting OpenAI Realtime/Responses with image arrays + transcript payloads.
- Implement backend LLM connector with configurable transport (REST/gRPC/WebSocket) and fallback rules.
- Design aggregation policy deciding final response text from OpenAI + private LLM signals.
- Add observability (structured logs, tracing spans) for latency measurements.

### Phase 3 — Response Delivery (Week 8-9)
- Integrate ElevenLabs TTS streaming API, buffer audio for synchronized playback.
- Extend overlay renderer with audio playback hooks and caption surfaces.
- Implement HUD components: capture status, waveform, transcript scroller, playback controls.
- Validate input passthrough and overlay performance under load.

### Phase 4 — Front-End & Tooling (Week 10-11)
- Expand `packages/core` and `packages/electron` bindings for agent control and diagnostics.
- Ship Electron control panel for configuration, logs, and manual testing.
- Add command-line utilities (via `xtask`) for provisioning credentials and running end-to-end demos.
- Author developer docs covering setup, architecture, and extension points.

### Phase 5 — Hardening & Launch (Week 12+)
- Implement telemetry export (latency, accuracy, usage metrics) with feature flags.
- Add automated integration tests combining speech, screenshots, and overlay playback.
- Conduct soak tests in representative game environments, capture performance baselines.
- Prepare release checklist, rollback plan, and customer onboarding materials.

## Dependencies & Enablers
- Credential management for OpenAI, ElevenLabs, and private LLM endpoints.
- GPU capability detection to ensure screenshot pipeline works across DX11/DX12/Vulkan paths.
- Reliable IPC transport upgrades for binary payloads (audio/image chunks).
- CI jobs covering Rust + TypeScript artifacts and mdBook documentation updates.

## Open Risks & Mitigations
- **Low-latency streaming**: Mitigate via buffering strategy, use of async runtimes, and profiling early.
- **Privacy compliance**: Establish data retention boundaries and user consent flows before capture features ship.
- **Cross-backend rendering differences**: Build abstraction tests per graphics API and fall back gracefully when capture unsupported.
- **Third-party API limits**: Implement retry, backoff, and quota monitoring; support offline or degraded modes when services unavailable.

YOU ARE ON WINDOWS