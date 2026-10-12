"use strict";

const STORAGE = {
  key: "notebook-notes-gemini-key",
  model: "notebook-notes-model",
  usage: "notebook-notes-daily-usage"
};
// Editable first-run fallback; update this single value when the Gemini catalog changes.
const DEFAULT_MODEL = "gemini-3.8-flash";
const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2000;
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    notes_markdown: { type: "string" },
    uncertain: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } }
        },
        required: ["word", "alternatives"]
      }
    }
  },
  required: ["notes_markdown", "uncertain"]
};

const $ = (id) => document.getElementById(id);
const state = {
  file: null,
  imageCanvas: null,
  imageUrl: null,
  notes: "",
  uncertain: [],
  pages: [],
  activePageIndex: -1,
  pendingAppend: false,
  activeFileName: "",
  retryUsed: false,
  canRetryStrips: false,
  stripsUsed: false,
  editing: false,
  cropCanvas: null,
  cropSelection: null,
  cropStart: null,
  cropPurpose: "manual",
  pendingCorrection: null,
  callsToday: readDailyUsage()
};

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readDailyUsage() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE.usage) || "{}");
    return stored.date === localDateKey() && Number.isFinite(stored.count) ? stored.count : 0;
  } catch {
    return 0;
  }
}

function countApiCall() {
  state.callsToday = readDailyUsage() + 1;
  try {
    localStorage.setItem(STORAGE.usage, JSON.stringify({ date: localDateKey(), count: state.callsToday }));
  } catch { /* Usage display is best-effort if storage is disabled. */ }
  renderUsage();
}

function renderUsage() {
  $("usage-chip").textContent = `${state.callsToday} ${state.callsToday === 1 ? "call" : "calls"} today`;
}

function getApiKey() {
  try { return localStorage.getItem(STORAGE.key) || ""; } catch { return ""; }
}

function getModel() {
  try { return (localStorage.getItem(STORAGE.model) || DEFAULT_MODEL).trim(); } catch { return DEFAULT_MODEL; }
}

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function refreshView() {
  const connected = Boolean(getApiKey());
  $("setup-view").hidden = connected;
  $("workspace").hidden = !connected;
  $("open-settings").hidden = !connected;
  renderUsage();
  if (connected) {
    $("settings-key").value = "";
    $("settings-model").value = getModel();
  } else {
    $("setup-model").value = getModel();
  }
}

function resizeImageCanvas(source, width, height) {
  const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  enhanceImage(canvas);
  return canvas;
}

function enhanceImage(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const coarse = document.createElement("canvas");
  const ratio = Math.min(0.12, 96 / Math.max(width, height));
  coarse.width = Math.max(1, Math.round(width * ratio));
  coarse.height = Math.max(1, Math.round(height * ratio));
  const coarseContext = coarse.getContext("2d", { willReadFrequently: true });
  coarseContext.drawImage(canvas, 0, 0, coarse.width, coarse.height);

  const illumination = document.createElement("canvas");
  illumination.width = width;
  illumination.height = height;
  const illuminationContext = illumination.getContext("2d", { willReadFrequently: true });
  illuminationContext.imageSmoothingEnabled = true;
  illuminationContext.imageSmoothingQuality = "high";
  illuminationContext.drawImage(coarse, 0, 0, width, height);

  const original = context.getImageData(0, 0, width, height);
  const background = illuminationContext.getImageData(0, 0, width, height);
  const pixels = original.data;
  const light = background.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    const backgroundLuminance = Math.max(80, light[i] * 0.2126 + light[i + 1] * 0.7152 + light[i + 2] * 0.0722);
    if (luminance < 1) continue;
    const relative = Math.max(0, Math.min(1.25, luminance / backgroundLuminance));
    const target = Math.max(0, Math.min(255, 245 * Math.pow(relative, 1.08)));
    const factor = target / luminance;
    pixels[i] = Math.min(255, pixels[i] * factor);
    pixels[i + 1] = Math.min(255, pixels[i + 1] * factor);
    pixels[i + 2] = Math.min(255, pixels[i + 2] * factor);
  }
  context.putImageData(original, 0, 0);
}

async function decodeImage(file) {
  if (window.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const canvas = resizeImageCanvas(bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      return canvas;
    } catch { /* Use the browser's image decoder as a compatibility fallback. */ }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    return resizeImageCanvas(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function updatePreview() {
  if (state.imageUrl?.startsWith("blob:")) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = state.imageCanvas.toDataURL("image/jpeg", 0.9);
  $("preview-image").src = state.imageUrl;
  $("selected-image").hidden = false;
  $("selected-name").textContent = state.file?.name || "Notebook page";
  $("selected-dimensions").textContent = `${state.imageCanvas.width} × ${state.imageCanvas.height} px · prepared in this browser`;
  $("upload-title").textContent = "Choose a different photo";
  $("upload-subtitle").textContent = "Tap to replace the selected page";
  $("image-edit-actions").hidden = false;
  $("convert-button").disabled = false;
}

function cloneCanvas(source) {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d").drawImage(source, 0, 0);
  return copy;
}

function cropRectFull(canvas) {
  return { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
}

function renderCropEditor() {
  const canvas = $("crop-canvas");
  const source = state.cropCanvas;
  if (!source) return;
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const rect = state.cropSelection || cropRectFull(source);
  if (rect.left > 0 || rect.top > 0 || rect.right < canvas.width || rect.bottom < canvas.height) {
    context.fillStyle = "rgba(13, 18, 15, .56)";
    context.fillRect(0, 0, canvas.width, rect.top);
    context.fillRect(0, rect.bottom, canvas.width, canvas.height - rect.bottom);
    context.fillRect(0, rect.top, rect.left, rect.bottom - rect.top);
    context.fillRect(rect.right, rect.top, canvas.width - rect.right, rect.bottom - rect.top);
    context.strokeStyle = "#b8d6a9";
    context.lineWidth = Math.max(2, Math.round(canvas.width / 700));
    context.strokeRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
  }
}

function openCropEditor(purpose = "manual") {
  if (!state.imageCanvas) return;
  state.cropPurpose = purpose;
  state.cropCanvas = cloneCanvas(state.imageCanvas);
  state.cropSelection = cropRectFull(state.cropCanvas);
  $("crop-instructions").textContent = purpose === "try-harder"
    ? "Drag around the unclear handwriting only. A smaller crop helps Gemini inspect the letters."
    : "Drag across the page to select a crop. Rotate if the page is sideways.";
  $("apply-crop").textContent = purpose === "try-harder" ? "Read this crop again" : "Use photo";
  renderCropEditor();
  $("crop-dialog").showModal();
}

function cropPoint(event) {
  const canvas = $("crop-canvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
  };
}

function rotateCropCanvas() {
  if (!state.cropCanvas) return;
  const source = state.cropCanvas;
  const rotated = document.createElement("canvas");
  rotated.width = source.height;
  rotated.height = source.width;
  const context = rotated.getContext("2d");
  context.translate(rotated.width / 2, rotated.height / 2);
  context.rotate(Math.PI / 2);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  state.cropCanvas = rotated;
  state.cropSelection = cropRectFull(rotated);
  renderCropEditor();
}

function applyCrop() {
  const source = state.cropCanvas;
  const rect = state.cropSelection || cropRectFull(source);
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const width = Math.min(source.width - left, Math.max(1, Math.ceil(rect.right - rect.left)));
  const height = Math.min(source.height - top, Math.max(1, Math.ceil(rect.bottom - rect.top)));
  if (width < 60 || height < 60) {
    $("crop-instructions").textContent = "That crop is too small to read. Select a larger area.";
    return;
  }
  if (state.cropPurpose === "try-harder" && width * height > source.width * source.height * 0.9) {
    $("crop-instructions").textContent = "Select a smaller area around the unclear handwriting to zoom in.";
    return;
  }
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  output.getContext("2d", { alpha: false }).drawImage(source, left, top, width, height, 0, 0, width, height);
  const purpose = state.cropPurpose;
  state.cropCanvas = null;
  state.cropPurpose = "manual";
  $("crop-dialog").close();
  $("crop-instructions").textContent = "Drag across the page to select a crop. Rotate if the page is sideways.";
  $("apply-crop").textContent = "Use photo";
  if (purpose === "try-harder") {
    retryWithCrop(output);
    return;
  }
  state.imageCanvas = output;
  updatePreview();
  hideError();
}

async function selectFile(file) {
  hideError();
  if (!file) return;
  state.canRetryStrips = false;
  state.retryUsed = false;
  state.stripsUsed = false;
  if (!file.type.startsWith("image/")) {
    showError("Please choose an image file (JPG, PNG or WebP).");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showError("That image is over 20 MB. Choose a smaller photo or resize it before uploading.");
    return;
  }
  try {
    state.file = file;
    state.imageCanvas = await decodeImage(file);
    updatePreview();
  } catch {
    state.file = null;
    state.imageCanvas = null;
    showError("We couldn’t open that image. Try a JPG, PNG or WebP photo.");
  }
}

function imageAsBase64(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function buildTranscriptionPrompt(subject, language, topic = "") {
  return [
    "Transcribe and organize the handwritten notebook or whiteboard image into clear, faithful study notes.",
    `Subject or topic: ${subject}.`,
    topic.trim() ? `Specific topic or class context: ${topic.trim()}.` : "",
    `Language: ${language}. If automatic, preserve the language(s) actually written.`,
    "Read carefully letter by letter. Handwriting may be very messy, slanted, cramped, connected, or rushed, with missing letters, corrections, and crossed-out words. Ignore crossed-out words.",
    "Use the subject and surrounding context to suggest likely readings, but do not silently guess. Mark a plausible but uncertain word in notes_markdown exactly as [?word?]. Mark unreadable text exactly as [???]. Include each uncertain marker in the uncertain array's word field and give short likely alternatives when possible.",
    "Keep the original meaning and language. Preserve accented characters, including Hungarian á, é, í, ó, ö, ő, ú, ü, ű; recognize common school abbreviations and subject terms. English or German may also appear.",
    "Organize the material with concise headings, bullets, and numbered steps where useful. Do not add facts that are not in the page.",
    "Rewrite formulas clearly using Unicode or LaTeX, including fractions, roots, subscripts, and arrows. Format table-like content as a Markdown table.",
    "Return only the requested JSON object."
  ].filter(Boolean).join("\n");
}

function extractInteractionText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const texts = [];
  const addContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  };
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (typeof item === "string") texts.push(item);
      else if (typeof item?.text === "string") texts.push(item.text);
      else addContent(item?.content);
    }
  }
  if (Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (step?.type === "model_output") {
        if (typeof step.text === "string") texts.push(step.text);
        addContent(step.content);
      }
    }
  }
  if (Array.isArray(payload.outputs)) {
    for (const output of payload.outputs) {
      if (typeof output?.text === "string") texts.push(output.text);
      addContent(output?.content);
    }
  }
  return texts.join("\n").trim();
}

function apiErrorMessage(status, payload) {
  const apiMessage = payload?.error?.message || "";
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(apiMessage)) {
    return "Today’s free quota is used up, or Google is rate-limiting requests. Try again later.";
  }
  if (status === 401 || status === 403 || /api key.*(invalid|not valid)|invalid.*api key/i.test(apiMessage)) {
    return "Google rejected this API key. Check that it’s copied correctly and that the Gemini API is enabled for it.";
  }
  if (status === 404 || /model.*(not found|does not exist|not available)/i.test(apiMessage)) {
    return "That model name wasn’t found or isn’t available to this key. Check the model name in Settings.";
  }
  if (status >= 500) return "Google’s Gemini service is having trouble right now. Please try again in a little while.";
  if (apiMessage) return apiMessage.slice(0, 220);
  return `Gemini request failed (${status}). Check your key, model name, and internet connection.`;
}

async function callGemini({ key = getApiKey(), model = getModel(), input, responseFormat, attempts = 3 }) {
  const base = 1000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    countApiCall();
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ model, input, store: false, ...(responseFormat ? { response_format: responseFormat } : {}) })
      });
    } catch {
      throw new Error("Couldn’t reach Google’s Gemini API. Check your internet connection and try again.");
    }

    let payload = {};
    try { payload = await response.json(); } catch { /* Keep the status-based message. */ }
    if (response.ok) {
      if (payload.status === "failed") {
        const apiStatus = Number(payload.error?.code) || 400;
        throw new Error(apiErrorMessage(apiStatus, payload).replaceAll(key, "[hidden]"));
      }
      return payload;
    }
    if (response.status === 429 && attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, base * (2 ** attempt)));
      continue;
    }
    throw new Error(apiErrorMessage(response.status, payload).replaceAll(key, "[hidden]"));
  }
  throw new Error("Today’s free quota is used up, or Google is rate-limiting requests. Try again later.");
}

function validateNoteResult(payload) {
  const raw = extractInteractionText(payload);
  if (!raw) {
    const error = new Error("Gemini returned no readable notes. Try a closer, brighter photo taken straight from above.");
    error.code = "unreadable";
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      const error = new Error("The response wasn’t readable. Please try the photo again.");
      error.code = "unreadable";
      throw error;
    }
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {
      const error = new Error("The response wasn’t readable. Please try the photo again.");
      error.code = "unreadable";
      throw error;
    }
  }
  if (typeof parsed.notes_markdown !== "string" || !parsed.notes_markdown.trim()) {
    const error = new Error("Gemini couldn’t read enough from this page. Try better light, move closer, and photograph it straight from above.");
    error.code = "unreadable";
    throw error;
  }
  return {
    notes: parsed.notes_markdown.trim(),
    uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : []
  };
}

function newPageRecord(result, options = {}) {
  return {
    notes: result.notes,
    uncertain: result.uncertain,
    imageUrl: state.imageUrl,
    imageCanvas: state.imageCanvas,
    fileName: state.file?.name || state.activeFileName || `page-${state.pages.length + 1}`,
    subject: $("subject-select").value,
    language: $("language-select").value,
    topic: $("topic-input").value,
    retryUsed: Boolean(options.retryUsed),
    canRetryStrips: Boolean(options.canRetryStrips),
    stripsUsed: Boolean(options.stripsUsed)
  };
}

function commitCurrentResult(result, options = {}) {
  const hasExistingPage = state.activePageIndex >= 0 && !state.pendingAppend;
  let page;
  if (hasExistingPage) {
    page = state.pages[state.activePageIndex];
    page.notes = result.notes;
    page.uncertain = result.uncertain;
    page.imageUrl = state.imageUrl || page.imageUrl;
    page.imageCanvas = state.imageCanvas || page.imageCanvas;
    if (options.retryUsed !== undefined) page.retryUsed = options.retryUsed;
    if (options.canRetryStrips !== undefined) page.canRetryStrips = options.canRetryStrips;
    if (options.stripsUsed !== undefined) page.stripsUsed = options.stripsUsed;
  } else {
    page = newPageRecord(result, options);
    state.pages.push(page);
    state.activePageIndex = state.pages.length - 1;
    state.pendingAppend = false;
  }
  state.notes = page.notes;
  state.uncertain = page.uncertain;
  state.imageUrl = page.imageUrl;
  state.imageCanvas = page.imageCanvas;
  state.activeFileName = page.fileName;
  state.retryUsed = page.retryUsed;
  state.canRetryStrips = page.canRetryStrips;
  state.stripsUsed = page.stripsUsed;
  state.file = null;
  $("capture-card").hidden = true;
  renderResult();
}

function notesInputForCanvas(canvas, prompt) {
  return [
    { type: "text", text: prompt },
    { type: "image", data: imageAsBase64(canvas), mime_type: "image/jpeg" }
  ];
}

async function requestNotes(canvas, prompt) {
  const response = await callGemini({
    input: notesInputForCanvas(canvas, prompt),
    responseFormat: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA }
  });
  return validateNoteResult(response);
}

async function convertPage() {
  if (!state.imageCanvas) return;
  if (!getApiKey()) {
    refreshView();
    return;
  }
  hideError();
  $("convert-button").disabled = true;
  $("loading-card").hidden = false;
  $("result-card").hidden = true;
  state.canRetryStrips = false;
  state.retryUsed = false;
  state.stripsUsed = false;
  $("loading-title").textContent = "Reading your page…";
  $("loading-subtitle").textContent = "Looking closely at every word and symbol.";
  try {
    const result = await requestNotes(
      state.imageCanvas,
      buildTranscriptionPrompt($("subject-select").value, $("language-select").value, $("topic-input").value)
    );
    const unknownCount = (result.notes.match(/\[\?\?\?\]/g) || []).length;
    commitCurrentResult(result, { canRetryStrips: unknownCount >= 6 });
  } catch (error) {
    if (error?.code === "unreadable") state.canRetryStrips = true;
    showError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
  } finally {
    $("loading-card").hidden = true;
    $("convert-button").disabled = !state.imageCanvas;
  }
}

async function retryWithCrop(cropCanvas) {
  if (!state.notes || state.retryUsed) return;
  hideError();
  state.retryUsed = true;
  saveActivePage();
  syncRetryActions();
  const originalNotes = state.notes;
  const page = state.activePageIndex >= 0 ? state.pages[state.activePageIndex] : null;
  const subject = page?.subject || $("subject-select").value;
  const language = page?.language || $("language-select").value;
  const topic = page?.topic || $("topic-input").value;
  $("loading-card").hidden = false;
  $("loading-title").textContent = "Taking a closer look…";
  $("loading-subtitle").textContent = "Re-reading only the crop you selected.";
  try {
    const prompt = [
      "The image is a zoomed crop from one part of a handwritten notebook page. Re-read this crop carefully, using the existing full-page transcription only as context.",
      `Subject or topic: ${subject}. Language: ${language}.`,
      topic.trim() ? `Specific class/topic context: ${topic.trim()}.` : "",
      "Do not guess silently. Preserve [?word?] for likely but uncertain readings and [???] for unreadable text. Ignore crossed-out text. Preserve original language, accents, formulas, and meaning.",
      "Return the complete revised notes_markdown, keeping everything outside this crop unchanged. Correct only text that this crop makes clearer. Keep the requested JSON structure.",
      "Existing full-page notes for context:\n" + originalNotes
    ].join("\n\n");
    const result = await requestNotes(cropCanvas, prompt);
    const unknownCount = (result.notes.match(/\[\?\?\?\]/g) || []).length;
    commitCurrentResult(result, { retryUsed: true, canRetryStrips: unknownCount >= 6 });
  } catch (error) {
    if (error?.code === "unreadable") state.canRetryStrips = true;
    syncRetryActions();
    showError(error instanceof Error ? error.message : "The closer reading failed. Try a larger, clearer crop.");
  } finally {
    $("loading-card").hidden = true;
  }
}

function makeHorizontalStrips(canvas, count = 3, overlapRatio = 0.1) {
  const baseHeight = Math.ceil(canvas.height / count);
  const overlap = Math.round(baseHeight * overlapRatio);
  return Array.from({ length: count }, (_, index) => {
    const top = Math.max(0, index * baseHeight - (index ? Math.floor(overlap / 2) : 0));
    const bottom = Math.min(canvas.height, (index + 1) * baseHeight + (index < count - 1 ? Math.ceil(overlap / 2) : 0));
    const strip = document.createElement("canvas");
    strip.width = canvas.width;
    strip.height = Math.max(1, bottom - top);
    strip.getContext("2d", { alpha: false }).drawImage(canvas, 0, top, canvas.width, bottom - top, 0, 0, strip.width, strip.height);
    return strip;
  });
}

async function readInStrips() {
  if (!state.imageCanvas || state.stripsUsed) return;
  hideError();
  state.stripsUsed = true;
  saveActivePage();
  syncRetryActions();
  $("loading-card").hidden = false;
  $("loading-title").textContent = "Reading the page in overlapping strips…";
  $("loading-subtitle").textContent = "This uses a few extra API calls, only because the full-page reading was unclear.";
  const strips = makeHorizontalStrips(state.imageCanvas);
  const page = state.activePageIndex >= 0 ? state.pages[state.activePageIndex] : null;
  const subject = page?.subject || $("subject-select").value;
  const language = page?.language || $("language-select").value;
  const topic = page?.topic || $("topic-input").value;
  const transcripts = [];
  const uncertain = [];
  try {
    for (let index = 0; index < strips.length; index += 1) {
      $("loading-subtitle").textContent = `Reading strip ${index + 1} of ${strips.length}…`;
      const context = transcripts.length
        ? `\n\nText already transcribed from the preceding overlapping strip(s). Do not duplicate those lines:\n${transcripts.join("\n")}`
        : "";
      const prompt = `${buildTranscriptionPrompt(subject, language, topic)}\n\nThis is horizontal strip ${index + 1} of ${strips.length} from a dense page. Transcribe the writing visible in this strip in its original order. There is a small overlap with adjacent strips.${context}`;
      const result = await requestNotes(strips[index], prompt);
      transcripts.push(result.notes);
      uncertain.push(...result.uncertain);
    }
    const notes = transcripts.join("\n\n");
    const unknownCount = (notes.match(/\[\?\?\?\]/g) || []).length;
    commitCurrentResult({ notes, uncertain }, { canRetryStrips: false, stripsUsed: true });
    state.canRetryStrips = unknownCount >= 3;
    if (state.activePageIndex >= 0) state.pages[state.activePageIndex].canRetryStrips = state.canRetryStrips;
    renderResult();
  } catch (error) {
    showError(error instanceof Error ? error.message : "The strip reading failed. Try a better-lit, closer photo.");
  } finally {
    $("loading-card").hidden = true;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function inlineMarkdown(source, occurrences) {
  const tokens = [];
  let text = source.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  text = escapeHtml(text);
  text = text.replace(/\[\?[^?\]\n]+\?\]|\[\?\?\?\]/g, (match) => {
    const index = occurrences.value++;
    const safe = escapeHtml(match);
    return `<button class="uncertain-word" type="button" data-uncertain-index="${index}" title="Tap to review this word">${safe}</button>`;
  });
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  return text;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const occurrences = { value: 0 };
  const output = [];
  let listType = null;
  let tableRows = [];
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const parsedRows = tableRows.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    const hasSeparator = parsedRows.length > 1 && parsedRows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
    const header = parsedRows[0];
    output.push("<table><thead><tr>" + header.map((cell) => `<th>${inlineMarkdown(cell, occurrences)}</th>`).join("") + "</tr></thead><tbody>");
    for (const row of parsedRows.slice(hasSeparator ? 2 : 1)) {
      output.push("<tr>" + header.map((_, index) => `<td>${inlineMarkdown(row[index] || "", occurrences)}</td>`).join("") + "</tr>");
    }
    output.push("</tbody></table>");
    tableRows = [];
  };

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      tableRows.push(line.trim());
      continue;
    }
    flushTable();
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2], occurrences)}</h${level}>`);
    } else if (unordered || ordered) {
      const type = unordered ? "ul" : "ol";
      if (listType !== type) { closeList(); output.push(`<${type}>`); listType = type; }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1], occurrences)}</li>`);
    } else if (/^\s*>\s?/.test(line)) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ""), occurrences)}</blockquote>`);
    } else if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      closeList();
      output.push("<hr>");
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${inlineMarkdown(line, occurrences)}</p>`);
    } else {
      closeList();
    }
  }
  flushTable();
  closeList();
  return output.join("");
}

function matchingUncertain(token, index) {
  const normalize = (value) => String(value || "").trim().replace(/^\[\?/, "").replace(/\?\]$/, "");
  const exact = state.uncertain.find((item) => item?.word === token || normalize(item?.word) === normalize(token));
  if (exact) return exact;
  if (token === "[???]") {
    return state.uncertain.find((item) => /unreadable|unknown|^\[?\?{3}\]?$/i.test(String(item?.word || "")))
      || { word: token, alternatives: [] };
  }
  return state.uncertain[index] || { word: token, alternatives: [] };
}

function syncRetryActions() {
  const unknownCount = (state.notes.match(/\[\?\?\?\]/g) || []).length;
  const hasResult = !$("result-card").hidden;
  $("try-harder-button").hidden = !hasResult || state.editing || unknownCount < 3 || state.retryUsed || !state.imageCanvas;
  $("retry-strips-button").hidden = !hasResult || !state.canRetryStrips || state.stripsUsed || !state.imageCanvas;
  $("error-retry-strips").hidden = $("error-message").hidden || !state.canRetryStrips || state.stripsUsed || !state.imageCanvas;
}

function renderPageTabs() {
  const tabs = $("page-tabs");
  tabs.textContent = "";
  tabs.hidden = state.pages.length < 2;
  state.pages.forEach((page, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-tab";
    button.textContent = `Page ${index + 1}`;
    button.setAttribute("aria-current", index === state.activePageIndex ? "page" : "false");
    button.addEventListener("click", () => activatePage(index));
    tabs.append(button);
  });
}

function saveActivePage() {
  if (state.activePageIndex < 0 || !state.pages[state.activePageIndex]) return;
  if (state.editing) state.notes = $("notes-editor").value;
  const page = state.pages[state.activePageIndex];
  page.notes = state.notes;
  page.uncertain = state.uncertain;
  page.retryUsed = state.retryUsed;
  page.canRetryStrips = state.canRetryStrips;
  page.stripsUsed = state.stripsUsed;
  page.imageCanvas = state.imageCanvas || page.imageCanvas;
  page.imageUrl = state.imageUrl || page.imageUrl;
  page.subject = $("subject-select").value;
  page.language = $("language-select").value;
  page.topic = $("topic-input").value;
}

function activatePage(index) {
  if (index < 0 || index >= state.pages.length || index === state.activePageIndex) return;
  saveActivePage();
  const page = state.pages[index];
  state.activePageIndex = index;
  state.notes = page.notes;
  state.uncertain = page.uncertain;
  state.imageUrl = page.imageUrl;
  state.imageCanvas = page.imageCanvas;
  state.activeFileName = page.fileName;
  $("subject-select").value = page.subject || "General";
  $("language-select").value = page.language || "Detect automatically";
  $("topic-input").value = page.topic || "";
  state.retryUsed = page.retryUsed;
  state.canRetryStrips = page.canRetryStrips;
  state.stripsUsed = page.stripsUsed;
  state.file = null;
  renderResult();
}

function renderResult() {
  $("result-card").hidden = false;
  $("capture-card").hidden = true;
  $("result-image").src = state.imageUrl;
  $("result-image").alt = `Notebook page ${state.activePageIndex + 1}`;
  $("result-photo").querySelector("figcaption").textContent = `Original page · Page ${state.activePageIndex + 1} · never saved by the app`;
  renderPageTabs();
  $("notes-editor").hidden = true;
  $("notes-preview").hidden = false;
  $("notes-preview").innerHTML = renderMarkdown(state.notes);
  $("edit-toggle").textContent = "Edit notes";
  state.editing = false;
  const unknownCount = (state.notes.match(/\[\?\?\?\]/g) || []).length;
  $("uncertainty-hint").textContent = unknownCount
    ? `${unknownCount} unreadable ${unknownCount === 1 ? "spot" : "spots"} marked [???]. Tap a highlighted word to review it.`
    : state.uncertain.length
      ? "Tap a highlighted word to review Gemini’s suggested alternatives."
      : "Give these notes a quick review. Handwriting recognition can make mistakes.";
  syncRetryActions();
}

function showError(message) {
  $("error-message").textContent = message;
  $("error-message").hidden = false;
  syncRetryActions();
}

function hideError() {
  $("error-message").hidden = true;
  $("error-message").textContent = "";
  syncRetryActions();
}

function clearSelectedImage() {
  if (state.imageUrl?.startsWith("blob:")) URL.revokeObjectURL(state.imageUrl);
  state.file = null;
  state.imageCanvas = null;
  state.imageUrl = null;
  $("photo-input").value = "";
  $("selected-image").hidden = true;
  $("image-edit-actions").hidden = true;
  $("preview-image").removeAttribute("src");
  $("upload-title").textContent = "Take a photo";
  $("upload-subtitle").textContent = "or choose one from your library";
  $("convert-button").disabled = true;
}

function addAnotherPage() {
  saveActivePage();
  state.pendingAppend = true;
  state.notes = "";
  state.uncertain = [];
  state.retryUsed = false;
  state.canRetryStrips = false;
  state.stripsUsed = false;
  state.activeFileName = "";
  state.editing = false;
  clearSelectedImage();
  $("result-card").hidden = true;
  $("capture-card").hidden = false;
  $("loading-card").hidden = true;
  hideError();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startOver() {
  clearSelectedImage();
  state.pages = [];
  state.activePageIndex = -1;
  state.pendingAppend = false;
  state.notes = "";
  state.uncertain = [];
  state.activeFileName = "";
  state.retryUsed = false;
  state.canRetryStrips = false;
  state.stripsUsed = false;
  state.editing = false;
  state.cropCanvas = null;
  state.cropPurpose = "manual";
  $("page-tabs").hidden = true;
  $("result-card").hidden = true;
  $("capture-card").hidden = false;
  $("loading-card").hidden = true;
  hideError();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exportMarkdown() {
  saveActivePage();
  if (state.pages.length <= 1) return state.pages[0]?.notes || state.notes;
  return state.pages.map((page, index) => `# Page ${index + 1}\n\n${page.notes}`).join("\n\n---\n\n");
}

function openUncertainEditor(token, index) {
  const record = matchingUncertain(token, index);
  const alternatives = Array.isArray(record.alternatives)
    ? [...new Set(record.alternatives.map((item) => String(item).trim()).filter(Boolean))].slice(0, 6)
    : [];
  state.pendingCorrection = { token, index };
  $("uncertain-title").textContent = `Review ${token}`;
  $("uncertain-caption").textContent = alternatives.length
    ? "Choose a suggested reading, or enter your own."
    : "No alternatives were suggested. If you can read it, enter a correction.";
  const list = $("alternative-list");
  list.textContent = "";
  for (const alternative of alternatives) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "alternative-choice";
    button.textContent = alternative;
    button.addEventListener("click", () => applyUncertainCorrection(alternative));
    list.append(button);
  }
  $("custom-correction").value = "";
  $("uncertain-dialog").showModal();
  if (!alternatives.length) $("custom-correction").focus();
}

function applyUncertainCorrection(replacement) {
  const target = state.pendingCorrection;
  if (!target || !replacement.trim()) return;
  let seen = 0;
  state.notes = state.notes.replace(/\[\?[^?\]\n]+\?\]|\[\?\?\?\]/g, (marker) => {
    const index = seen++;
    return index === target.index ? replacement.trim() : marker;
  });
  if (state.activePageIndex >= 0) {
    state.pages[state.activePageIndex].notes = state.notes;
    state.pages[state.activePageIndex].uncertain = state.uncertain;
  }
  state.pendingCorrection = null;
  $("uncertain-dialog").close();
  renderResult();
  $("uncertainty-hint").textContent = "Correction applied. Give these notes a quick review.";
}

async function testKey(key, model, messageElement) {
  if (!key.trim()) {
    showMessage(messageElement, "Paste an API key first.", true);
    return false;
  }
  if (!model.trim()) {
    showMessage(messageElement, "Enter a model name first.", true);
    return false;
  }
  const testButtons = [$("setup-test"), $("settings-test")];
  testButtons.forEach((button) => { button.disabled = true; });
  showMessage(messageElement, "Testing key and model…");
  try {
    const response = await callGemini({
      key: key.trim(),
      model: model.trim(),
      input: "Reply with exactly the single word OK.",
      attempts: 3
    });
    if (!extractInteractionText(response)) throw new Error("The request succeeded, but the model returned no text.");
    showMessage(messageElement, "Connection successful — this key and model are working.");
    return true;
  } catch (error) {
    showMessage(messageElement, error.message || "The test failed. Check your key and model name.", true);
    return false;
  } finally {
    testButtons.forEach((button) => { button.disabled = false; });
  }
}

function openSettings() {
  $("settings-key").value = "";
  $("settings-model").value = getModel();
  $("settings-message").textContent = "";
  $("settings-message").classList.remove("is-error");
  $("settings-dialog").showModal();
}

function saveSettings(key, model) {
  try {
    localStorage.setItem(STORAGE.key, key.trim());
    localStorage.setItem(STORAGE.model, model.trim());
    return true;
  } catch {
    return false;
  }
}

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename() {
  const base = (state.file?.name || state.activeFileName || state.pages[0]?.fileName || "notebook-notes").replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return base || "notebook-notes";
}

function wireEvents() {
  $("photo-input").addEventListener("change", (event) => selectFile(event.currentTarget.files?.[0]));
  $("convert-button").addEventListener("click", convertPage);
  $("remove-image").addEventListener("click", () => { clearSelectedImage(); hideError(); });
  $("open-crop").addEventListener("click", () => openCropEditor("manual"));
  $("try-harder-button").addEventListener("click", () => openCropEditor("try-harder"));
  $("retry-strips-button").addEventListener("click", readInStrips);
  $("error-retry-strips").addEventListener("click", readInStrips);
  $("add-page").addEventListener("click", addAnotherPage);
  $("close-crop").addEventListener("click", () => $("crop-dialog").close());
  $("cancel-crop").addEventListener("click", () => $("crop-dialog").close());
  $("rotate-image").addEventListener("click", rotateCropCanvas);
  $("reset-crop").addEventListener("click", () => {
    if (!state.cropCanvas) return;
    state.cropSelection = cropRectFull(state.cropCanvas);
    renderCropEditor();
  });
  $("apply-crop").addEventListener("click", applyCrop);
  $("crop-dialog").addEventListener("click", (event) => {
    if (event.target === $("crop-dialog")) $("crop-dialog").close();
  });
  $("crop-canvas").addEventListener("pointerdown", (event) => {
    const canvas = $("crop-canvas");
    const point = cropPoint(event);
    state.cropStart = point;
    state.cropSelection = { left: point.x, top: point.y, right: point.x, bottom: point.y };
    canvas.setPointerCapture(event.pointerId);
    renderCropEditor();
  });
  $("crop-canvas").addEventListener("pointermove", (event) => {
    if (!state.cropStart) return;
    const point = cropPoint(event);
    state.cropSelection = {
      left: Math.min(state.cropStart.x, point.x),
      top: Math.min(state.cropStart.y, point.y),
      right: Math.max(state.cropStart.x, point.x),
      bottom: Math.max(state.cropStart.y, point.y)
    };
    renderCropEditor();
  });
  const finishCropDrag = () => { state.cropStart = null; };
  $("crop-canvas").addEventListener("pointerup", finishCropDrag);
  $("crop-canvas").addEventListener("pointercancel", finishCropDrag);
  $("open-settings").addEventListener("click", openSettings);
  $("settings-dialog").addEventListener("click", (event) => {
    if (event.target === $("settings-dialog")) $("settings-dialog").close();
  });
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const key = $("setup-key").value.trim();
    const model = $("setup-model").value.trim();
    if (!key || !model) return;
    if (!saveSettings(key, model)) {
      showMessage($("setup-message"), "Couldn’t save in this browser. Check that local storage is enabled.", true);
      return;
    }
    $("setup-key").value = "";
    refreshView();
  });
  $("setup-test").addEventListener("click", () => testKey($("setup-key").value, $("setup-model").value, $("setup-message")));
  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const typedKey = $("settings-key").value.trim();
    const key = typedKey || getApiKey();
    const model = $("settings-model").value.trim();
    if (!key || !model) {
      showMessage($("settings-message"), "Enter an API key and model name.", true);
      return;
    }
    if (!saveSettings(key, model)) {
      showMessage($("settings-message"), "Couldn’t save in this browser. Check that local storage is enabled.", true);
      return;
    }
    $("settings-key").value = "";
    showMessage($("settings-message"), "Settings saved on this device.");
    refreshView();
  });
  $("settings-test").addEventListener("click", () => testKey(
    $("settings-key").value.trim() || getApiKey(),
    $("settings-model").value,
    $("settings-message")
  ));
  $("delete-key").addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE.key);
      localStorage.removeItem(STORAGE.model);
      $("settings-key").value = "";
      $("settings-model").value = DEFAULT_MODEL;
      $("settings-dialog").close();
      $("setup-model").value = DEFAULT_MODEL;
      $("setup-message").textContent = "";
      startOver();
      refreshView();
    } catch {
      showMessage($("settings-message"), "Couldn’t delete the key. Check that local storage is enabled.", true);
    }
  });
  $("edit-toggle").addEventListener("click", () => {
    state.editing = !state.editing;
    if (state.editing) {
      $("notes-editor").value = state.notes;
      $("notes-editor").hidden = false;
      $("notes-preview").hidden = true;
      $("edit-toggle").textContent = "Save edits";
      $("notes-editor").focus();
      syncRetryActions();
    } else {
      state.notes = $("notes-editor").value;
      saveActivePage();
      $("notes-editor").hidden = true;
      $("notes-preview").hidden = false;
      $("notes-preview").innerHTML = renderMarkdown(state.notes);
      $("edit-toggle").textContent = "Edit notes";
      state.editing = false;
      syncRetryActions();
    }
  });
  $("notes-preview").addEventListener("click", (event) => {
    const button = event.target.closest(".uncertain-word");
    if (!button) return;
    openUncertainEditor(button.textContent, Number(button.dataset.uncertainIndex));
  });
  $("close-uncertain").addEventListener("click", () => $("uncertain-dialog").close());
  $("keep-uncertain").addEventListener("click", () => {
    state.pendingCorrection = null;
    $("uncertain-dialog").close();
  });
  $("uncertain-dialog").addEventListener("click", (event) => {
    if (event.target === $("uncertain-dialog")) $("uncertain-dialog").close();
  });
  $("uncertain-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const correction = $("custom-correction").value.trim();
    if (correction) applyUncertainCorrection(correction);
    else $("custom-correction").focus();
  });
  $("copy-button").addEventListener("click", async () => {
    if (state.editing) {
      state.notes = $("notes-editor").value;
      saveActivePage();
    }
    const text = exportMarkdown();
    try {
      await navigator.clipboard.writeText(text);
      $("copy-button").textContent = "Copied!";
      setTimeout(() => { $("copy-button").textContent = "Copy"; }, 1500);
    } catch {
      showError("Clipboard access is unavailable here. Select the note text and copy it manually.");
    }
  });
  $("download-md").addEventListener("click", () => downloadText(`${safeFilename()}.md`, exportMarkdown(), "text/markdown;charset=utf-8"));
  $("download-txt").addEventListener("click", () => {
    const plain = exportMarkdown().replace(/^#{1,6}\s+/gm, "").replace(/[*_~`]/g, "").replace(/^\s*[-*+]\s+/gm, "• ");
    downloadText(`${safeFilename()}.txt`, plain, "text/plain;charset=utf-8");
  });
  $("start-over").addEventListener("click", startOver);
}

wireEvents();
refreshView();
window.setInterval(() => {
  const latestCount = readDailyUsage();
  if (latestCount !== state.callsToday) {
    state.callsToday = latestCount;
    renderUsage();
  }
}, 60_000);

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Offline support is optional; recognition still works without a service worker.
  });
}
