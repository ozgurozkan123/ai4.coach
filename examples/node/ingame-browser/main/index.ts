import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } from 'electron';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirname = dirname(fileURLToPath(import.meta.url));
const hudHtmlPath = (() => {
  const candidates = [
    join(moduleDirname, 'hud.html'),
    join(moduleDirname, '..', 'hud.html'),
    join(moduleDirname, '../../main', 'hud.html'),
    join(process.cwd(), 'examples', 'node', 'ingame-browser', 'hud.html'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`HUD template not found. Looked in: ${candidates.join(', ')}`);
})();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

if (!ELEVENLABS_API_KEY) {
  throw new Error('ELEVENLABS_API_KEY environment variable is required');
}

if (!ELEVENLABS_VOICE_ID) {
  throw new Error('ELEVENLABS_VOICE_ID environment variable is required');
}

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 480;

let ipcHandlerRegistered = false;
let hudWindow: BrowserWindow | null = null;
let interactive = false;
let screenshotBuffer: ScreenshotFrame[] = [];
let screenshotTimer: NodeJS.Timeout | null = null;
let pttActive = false;
let continuousActive = false;
let forceTransparent = false;

type ConversationMessage = { role: 'system' | 'assistant' | 'user'; content: string };
type ScreenshotFrame = {
  dataUrl: string;
  capturedAt: number;
};

const SCREENSHOT_BUFFER_LIMIT = 20;
const SCREENSHOT_CAPTURE_INTERVAL_MS = 1_000;

let capturingScreenshot = false;

async function captureScreenshotFrame(): Promise<ScreenshotFrame | null> {
  if (capturingScreenshot) {
    return null;
  }

  capturingScreenshot = true;

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const targetWidth = Math.min(1280, width);
    const targetHeight = Math.round((targetWidth / width) * height);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight,
      },
    });

    const matchedSource = sources.find(source => source.display_id === primaryDisplay.id.toString()) ?? sources[0];
    if (!matchedSource) {
      return null;
    }

    const pngBuffer = matchedSource.thumbnail.toPNG();
    const base64 = pngBuffer.toString('base64');

    return {
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      capturedAt: Date.now(),
    };
  } catch (error) {
    console.warn('Failed to capture screenshot frame', error);
    return null;
  } finally {
    capturingScreenshot = false;
  }
}

async function pushScreenshotFrame() {
  const frame = await captureScreenshotFrame();
  if (!frame) {
    return;
  }

  screenshotBuffer.push(frame);
  if (screenshotBuffer.length > SCREENSHOT_BUFFER_LIMIT) {
    screenshotBuffer.splice(0, screenshotBuffer.length - SCREENSHOT_BUFFER_LIMIT);
  }
}

function startScreenshotCapture() {
  if (screenshotTimer) {
    return;
  }

  void pushScreenshotFrame();
  screenshotTimer = setInterval(() => {
    void pushScreenshotFrame();
  }, SCREENSHOT_CAPTURE_INTERVAL_MS);
}

function stopScreenshotCapture() {
  if (!screenshotTimer) {
    return;
  }

  clearInterval(screenshotTimer);
  screenshotTimer = null;
}

function selectScreenshots(start: number, end: number): ScreenshotFrame[] {
  const before = screenshotBuffer
    .filter(frame => frame.capturedAt < start)
    .slice(-5);

  const during = screenshotBuffer
    .filter(frame => frame.capturedAt >= start && frame.capturedAt <= end + 1000)
    .slice(0, 5);

  const deduped: ScreenshotFrame[] = [];
  const seen = new Set<number>();

  for (const frame of [...before, ...during]) {
    if (seen.has(frame.capturedAt)) {
      continue;
    }
    seen.add(frame.capturedAt);
    deduped.push(frame);
  }

  return deduped.slice(0, 10);
}

function broadcastInteractionState(force = false) {
  const win = hudWindow;
  if (!win || win.isDestroyed()) {
    return;
  }

  if (!force && win.webContents.isLoadingMainFrame()) {
    return;
  }

  try {
    win.webContents.send('hud:interaction', interactive);
  } catch {
    // Ignore attempts to send while the window is shutting down.
  }
}

function applyHudWindowState() {
  const win = hudWindow;
  if (!win || win.isDestroyed()) {
    return;
  }

  const ignoreInput = forceTransparent || !interactive;
  win.setIgnoreMouseEvents(ignoreInput, { forward: true });
  win.setFocusable(!ignoreInput);

  const targetOpacity = forceTransparent ? 0 : (interactive ? 1 : 0.15);
  win.setOpacity(targetOpacity);

  if (!ignoreInput && interactive) {
    win.focus();
  }
}

function setHudInteraction(enabled: boolean) {
  interactive = enabled;
  applyHudWindowState();
  broadcastInteractionState();
}

function notifyPttState(active: boolean, status?: string, mode: 'press' | 'continuous' = 'press') {
  const win = hudWindow;
  if (!win || win.isDestroyed()) {
    return;
  }

  try {
    win.webContents.send('hud:push-to-talk', {
      active,
      status: status ?? (active ? 'Listening... release to stop.' : 'Processing your request...'),
      mode,
    });
  } catch (error) {
    console.warn('Failed to notify HUD about PTT state', error);
  }
}

function sendHudStatus(message: string) {
  const win = hudWindow;
  if (!win || win.isDestroyed()) {
    return;
  }

  try {
    win.webContents.send('hud:status', message);
  } catch (error) {
    console.warn('Failed to send HUD status', error);
  }
}

function setForceTransparency(enabled: boolean) {
  forceTransparent = enabled;
  applyHudWindowState();
  sendHudStatus(
    forceTransparent
      ? 'Overlay fully transparent. Press Shift + D to restore visibility.'
      : 'Overlay visibility restored.',
  );
}

function createHudWindow(): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    return hudWindow;
  }

  const display = screen.getPrimaryDisplay();
  const x = Math.round((display.bounds.width - WINDOW_WIDTH) / 2);
  const y = Math.round((display.bounds.height - WINDOW_HEIGHT) / 2);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  hudWindow = win;
  interactive = false;

  win.webContents.once('did-finish-load', () => {
    broadcastInteractionState(true);
  });

  void win.loadFile(hudHtmlPath);

  win.on('closed', () => {
    hudWindow = null;
    interactive = false;
  });

  setHudInteraction(false);

  return win;
}

async function ensureIpcHandler() {
  if (ipcHandlerRegistered) {
    return;
  }

  ipcHandlerRegistered = true;

  ipcMain.handle('voice:process', async (_event, payload: {
    audioBase64: string;
    mimeType: string;
    history: ConversationMessage[];
    screenshotMode?: 'off' | 'primary';
  }) => {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY is not set.');
    }

    const history = Array.isArray(payload?.history) ? payload.history : [];
    const screenshotMode = payload?.screenshotMode ?? 'primary';
    const audioBytes = Buffer.from(payload.audioBase64, 'base64');
    if (audioBytes.byteLength === 0) {
      throw new Error('Empty audio payload received.');
    }

    const recordingStartedAt = Date.now();

    startScreenshotCapture();

    const formData = new FormData();
    formData.append('model', 'gpt-4o-mini-transcribe');
    formData.append('response_format', 'json');
    formData.append('file', new Blob([audioBytes], { type: payload.mimeType ?? 'audio/webm' }), 'input.webm');

    const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!transcriptionResponse.ok) {
      const errorPayload = await transcriptionResponse.text();
      throw new Error(`Transcription failed: ${errorPayload}`);
    }

    const transcriptionJson = await transcriptionResponse.json() as { text?: string };
    const transcript = transcriptionJson.text?.trim() ?? '';

    const recordingEndedAt = Date.now();

    const chatMessages: ConversationMessage[] = [
      { role: 'system', content: 'You are an overlay voice assistant. Provide concise, helpful answers.' },
      ...history,
    ];

    if (transcript.length !== 0) {
      chatMessages.push({ role: 'user', content: transcript });
    }

    const screenshotFrames: ScreenshotFrame[] = screenshotMode === 'primary'
      ? selectScreenshots(recordingStartedAt - 5_000, recordingEndedAt)
      : [];

    const multimodalContent = [
      {
        type: 'input_text',
        text: `Transcribed voice command:\n${transcript || '(no speech detected)'}`,
      },
    ];

    if (chatMessages.length !== 0) {
      multimodalContent.push({
        type: 'input_text',
        text: `Conversation history summary:\n${chatMessages.map(message => `${message.role}: ${message.content}`).join('\n')}`,
      });
    }

    const multimodalInput: Array<{
      role: 'user';
      content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      >;
    }> = [
      {
        role: 'user',
        content: multimodalContent,
      },
    ];

    if (screenshotFrames.length !== 0) {
      multimodalInput.push({
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Captured screenshots (chronological order, most recent last):',
        }],
      });

      for (const frame of screenshotFrames) {
        multimodalInput.push({
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: `data:image/png;base64,${frame.base64}`,
          }],
        });
      }
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: multimodalInput,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.text();
      throw new Error(`Multimodal response failed: ${errorPayload}`);
    }

    const responseJson = await response.json() as {
      output_text?: string;
      output?: Array<{
        content?: Array<{ type: string; text?: string }>;
      }>;
    };

    let responseText = responseJson.output_text?.trim() ?? '';

    if (!responseText && Array.isArray(responseJson.output)) {
      const collected: string[] = [];
      for (const block of responseJson.output) {
        if (!Array.isArray(block.content)) {
          continue;
        }
        for (const item of block.content) {
          if (item?.type === 'output_text' && typeof item.text === 'string') {
            collected.push(item.text);
          }
        }
      }
      responseText = collected.join('\n').trim();
    }

    stopScreenshotCapture();

    if (responseText.length === 0) {
      return {
        transcript,
        responseText: '',
        voiceBase64: null,
        screenshots: screenshotFrames,
      };
    }

    const ttsBody = {
      text: responseText,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.7,
      },
    };

    const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify(ttsBody),
    });

    if (!ttsResponse.ok) {
      const errorPayload = await ttsResponse.text();
      throw new Error(`ElevenLabs synthesis failed: ${errorPayload}`);
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());

    const responsePayload = {
      transcript,
      responseText,
      voiceBase64: audioBuffer.toString('base64'),
      screenshots: screenshotFrames,
      screenshotTimeline: {
        recordingStartedAt,
        recordingEndedAt,
      },
    };

    if (screenshotMode === 'primary') {
      const selected = selectScreenshots(recordingStartedAt - 5_000, recordingEndedAt);
      responsePayload.screenshots = selected;
      responsePayload.screenshotTimeline = {
        recordingStartedAt: recordingStartedAt - 5_000,
        recordingEndedAt,
      };
    }

    return responsePayload;
  });
}

async function main() {
  await app.whenReady();
  await ensureIpcHandler();

  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media' || permission === 'audioCapture') {
      return true;
    }
    return false;
  });

  defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture') {
      callback(true);
      return;
    }

    callback(false);
  });

  createHudWindow();
  setHudInteraction(false);

  const registered = globalShortcut.register('Shift+A', () => {
    const next = !interactive;
    setHudInteraction(next);
    notifyPttState(next, next ? 'Overlay active.' : 'Overlay hidden. Press Shift + Z to speak.');
  });

  if (!registered) {
    console.warn('Failed to register Shift+A shortcut.');
  }

  const pttRegistered = globalShortcut.register('Shift+Z', () => {
    pttActive = !pttActive;

    if (pttActive) {
      notifyPttState(true, 'Listening... press Shift + Z again to stop.');
      return;
    }

    notifyPttState(false, 'Processing your request...');
  });

  if (!pttRegistered) {
    console.warn('Failed to register Shift+Z shortcut.');
  }

  const continuousRegistered = globalShortcut.register('Shift+X', () => {
    continuousActive = !continuousActive;
    notifyPttState(continuousActive, continuousActive
      ? 'Continuous listening enabled.'
      : 'Continuous listening disabled.',
    continuousActive ? 'continuous' : 'continuous');
  });

  if (!continuousRegistered) {
    console.warn('Failed to register Shift+X shortcut.');
  }

  const transparencyRegistered = globalShortcut.register('Shift+D', () => {
    setForceTransparency(!forceTransparent);
  });

  if (!transparencyRegistered) {
    console.warn('Failed to register Shift+D shortcut.');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createHudWindow();
      setHudInteraction(false);
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

main().catch((error: unknown) => {
  console.error(error);
  app.quit();
});
